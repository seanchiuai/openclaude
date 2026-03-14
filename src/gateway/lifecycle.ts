/**
 * Gateway lifecycle management.
 * Handles startup, shutdown, and signal handling.
 */
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { paths } from "../config/paths.js";
import { ensureDirectories, loadConfig } from "../config/loader.js";
import { createLogger } from "../logging/logger.js";
import { startDiagnosticHeartbeat, stopDiagnosticHeartbeat, markActivity } from "../logging/diagnostic.js";
import { createProcessPool } from "../engine/pool.js";
import { createGatewayApp, startHttpServer } from "./http.js";
import { createAuthMiddleware } from "./auth.js";
import { createRouter } from "../router/index.js";
import { loadSkills } from "../skills/index.js";
import { sweepStaleSessions } from "../engine/session-cleanup.js";
import { cleanStaleGatewayProcessesSync } from "../engine/orphan-reaper.js";
import { killProcessGroup } from "../engine/spawn.js";
import { MemoryIndexManager, closeAllMemoryIndexManagers } from "../memory/index.js";
import { createCronService } from "../cron/index.js";
import { createHeartbeatRunner } from "../cron/heartbeat.js";
import { requestHeartbeatNow } from "../cron/heartbeat-wake.js";
import { createSubagentRegistry, type SubagentRegistry, type SubagentRun } from "../engine/subagent-registry.js";
import { createAnnouncePipeline } from "../engine/subagent-announce.js";
import { buildChildSystemPrompt } from "../engine/system-prompt.js";
import { join } from "node:path";
import type { OpenClaudeConfig } from "../config/types.js";
import type { ProcessPool } from "../engine/pool.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { MemorySearchManager } from "../memory/index.js";
import type { CronService } from "../cron/index.js";
import type { HeartbeatRunner } from "../cron/heartbeat.js";
import type { CronDeliveryTarget } from "../cron/types.js";

export interface Gateway {
  config: OpenClaudeConfig;
  pool: ProcessPool;
  channels: Map<string, ChannelAdapter>;
  memoryManager?: MemorySearchManager;
  cronService?: CronService;
  subagentRegistry?: SubagentRegistry;
  shutdown: () => Promise<void>;
}

const log = createLogger("gateway");

export async function startGateway(configPath?: string): Promise<Gateway> {
  ensureDirectories();

  const config = loadConfig(configPath);
  const pool = createProcessPool(config.agent.maxConcurrent);
  const channels = new Map<string, ChannelAdapter>();
  const channelNames: string[] = [];

  // Create memory manager
  const memoryManager = config.memory.enabled
    ? await MemoryIndexManager.get({
        memoryConfig: config.memory,
        workspaceDir: paths.base,
      })
    : null;

  // Fire-and-forget initial memory sync
  if (memoryManager?.sync) {
    memoryManager.sync({ reason: "startup" }).catch((err: unknown) => {
      log.warn("Initial memory sync failed", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  // Subagent registry
  const subagentRegistry = createSubagentRegistry(join(paths.base, "subagent-runs.json"));
  subagentRegistry.reconcileOrphans((sessionId) => {
    const session = pool.getSession(sessionId);
    return session?.status === "running";
  });

  // Helper to deliver text to a channel adapter
  const deliverToChannel = async (target: CronDeliveryTarget, text: string): Promise<void> => {
    const adapter = channels.get(target.channel);
    if (adapter) {
      await adapter.sendText(target.chatId, text);
    }
  };

  const gatewayPort = config.gateway.port;

  // Reap stale gateway processes from previous crash
  const reaped = cleanStaleGatewayProcessesSync(gatewayPort);
  if (reaped.length > 0) {
    log.info(`Reaped ${reaped.length} stale process(es) from previous run`);
  }

  const gatewayUrl = `http://localhost:${gatewayPort}`;

  // Resolve gateway token for auth
  const gatewayToken = config.gateway.auth.mode === "token"
    ? (config.gateway.auth.token ?? process.env.OPENCLAUDE_GATEWAY_TOKEN)
    : undefined;

  // Sweep stale session directories on startup
  const sweepResult = sweepStaleSessions(paths.sessions);
  if (sweepResult.removed.length > 0) {
    log.info(`Cleaned ${sweepResult.removed.length} stale session(s)`);
  }

  // Cron service
  let cronService: CronService | undefined;
  if (config.cron.enabled) {
    cronService = createCronService({
      storePath: config.cron.storePath,
      runIsolatedJob: async (job) => {
        const sessionId = `cron-${job.id}-${Date.now()}`;
        try {
          const result = await pool.submit({
            sessionId,
            prompt: job.prompt,
            timeout: 300_000,
            mcpConfig: config.mcp,
            gatewayUrl,
            gatewayToken,
          });
          return { status: "ok" as const, summary: result.text };
        } catch (err) {
          return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
        }
      },
      deliverResult: deliverToChannel,
      onJobComplete: (job, outcome) => {
        if (outcome.status === "ok") {
          requestHeartbeatNow({ reason: `cron:${job.name}` });
        }
      },
    });
    cronService.start();
    log.info("Cron service started");
  }

  // Heartbeat runner
  let heartbeat: HeartbeatRunner | undefined;
  if (config.heartbeat.enabled) {
    heartbeat = createHeartbeatRunner(
      {
        enabled: true,
        every: config.heartbeat.every,
        checklistPath: paths.heartbeat,
        prompt: config.heartbeat.prompt,
        ackMaxChars: config.heartbeat.ackMaxChars,
        target: config.heartbeat.target,
        activeHours: config.heartbeat.activeHours,
        agents: config.heartbeat.agents,
      },
      {
        runIsolated: async (prompt) => {
          const sessionId = `heartbeat-${Date.now()}`;
          try {
            const result = await pool.submit({
              sessionId,
              prompt,
              timeout: 300_000,
              mcpConfig: config.mcp,
              gatewayUrl,
              gatewayToken,
            });
            return { status: "ok" as const, summary: result.text };
          } catch (err) {
            return { status: "error" as const, error: err instanceof Error ? err.message : String(err) };
          }
        },
        deliver: deliverToChannel,
      },
    );
    heartbeat.start();
    log.info("Heartbeat started");
  }

  // Load skills from ~/.openclaude/skills/
  const skills = await loadSkills(paths.skills);
  if (skills.length > 0) {
    log.info(`Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  }

  // Router returns response text — the channel bot sends it back directly
  const rawRouter = createRouter({ pool, memoryManager: memoryManager ?? undefined, cronService, subagentRegistry, skills, mcpConfig: config.mcp, gatewayUrl, gatewayToken });
  const router: typeof rawRouter = (msg, onEvent) => {
    markActivity();
    return rawRouter(msg, onEvent);
  };

  // Announce pipeline — resumes parent when children complete
  const announcePipeline = createAnnouncePipeline({
    resumeParent: async (parentSessionId, runs, message) => {
      const parentCompletion = pool.getCompletion(parentSessionId);
      if (parentCompletion) await parentCompletion;

      await rawRouter({
        channel: "system",
        chatId: parentSessionId,
        userId: "system",
        username: "system",
        text: message,
        source: "system",
      });

      for (const run of runs) subagentRegistry.markAnnounced(run.runId);
    },
  });

  // Spawn handler — called when a new subagent is requested via HTTP API
  const onSubagentSpawn = (run: SubagentRun) => {
    const childSystemPrompt = buildChildSystemPrompt(run.task, run.parentSessionId);
    const timeoutMs = (run.timeoutSeconds ?? 300) * 1000;

    pool.submit({
      sessionId: run.childSessionId,
      prompt: run.task,
      timeout: timeoutMs,
      systemPrompt: childSystemPrompt,
      mcpConfig: config.mcp,
      gatewayUrl,
      gatewayToken,
      model: run.model,
    }).then((result) => {
      subagentRegistry.endRun(run.runId, "completed", result.text);
      const updatedRun = subagentRegistry.get(run.runId)!;
      updatedRun.usage = result.usage;
      updatedRun.childClaudeSessionId = result.claudeSessionId;
      announcePipeline.enqueue(updatedRun);
    }).catch((err) => {
      const errorMsg = err instanceof Error ? err.message : String(err);
      subagentRegistry.endRun(run.runId, "failed", undefined, errorMsg);
      announcePipeline.enqueue(subagentRegistry.get(run.runId)!);
    });

    run.status = "running";
    run.startedAt = Date.now();
  };

  // Create auth middleware
  const authResult = createAuthMiddleware(config.gateway.auth);

  // Start HTTP server
  const appStartedAt = Date.now();
  const app = createGatewayApp({
    pool,
    startedAt: appStartedAt,
    channels: channelNames,
    cronService,
    memoryManager: memoryManager ?? undefined,
    channelAdapters: channels,
    authMiddleware: authResult.middleware,
    subagentRegistry,
    onSubagentSpawn,
  });
  const server = startHttpServer(app, gatewayPort);
  const startedAt = Date.now();

  // Start diagnostic heartbeat
  startDiagnosticHeartbeat({ pool, cronService, startedAt: appStartedAt });

  // Start Telegram if configured
  if (config.channels.telegram?.enabled) {
    const { createTelegramChannel } = await import(
      "../channels/telegram/index.js"
    );

    const telegram = createTelegramChannel(config.channels.telegram, router);
    await telegram.start();
    channels.set("telegram", telegram);
    channelNames.push("telegram");
  }

  // Start Slack if configured
  if (config.channels.slack?.enabled) {
    const { createSlackChannel } = await import("../channels/slack/index.js");

    const slack = createSlackChannel(config.channels.slack, async (msg) => {
      const response = await router({
        channel: msg.channel,
        chatId: msg.chatId,
        userId: msg.userId,
        username: msg.username,
        text: msg.text,
        source: msg.source as "user" | "cron" | "system",
      });
      if (response && msg.chatId) {
        await slack.sendText(msg.chatId, response);
      }
      return response;
    });
    await slack.start();
    channels.set("slack", slack);
    channelNames.push("slack");
    log.info("Slack channel started");
  }

  // Write PID file
  writePidFile();

  log.info(`Started on port ${gatewayPort}`);
  if (channelNames.length > 0) {
    log.info(`Channels: ${channelNames.join(", ")}`);
  }

  const shutdown = async () => {
    log.info("Shutting down...");

    // Stop heartbeat first
    if (heartbeat) {
      heartbeat.stop();
      log.info("Heartbeat stopped");
    }

    // Stop cron
    if (cronService) {
      cronService.stop();
      log.info("Cron service stopped");
    }

    // Close all memory managers
    await closeAllMemoryIndexManagers();
    log.info("Memory closed");

    // Stop channels
    for (const [name, channel] of channels) {
      try {
        await channel.stop();
        log.info(`Stopped channel: ${name}`);
      } catch {
        // Best effort
      }
    }

    // Stop diagnostic heartbeat
    stopDiagnosticHeartbeat();

    // Drain process pool
    await pool.drain();

    // Stop HTTP server
    server.close();

    // Remove PID file
    removePidFile();

    log.info("Shutdown complete.");
  };

  // Graceful shutdown on signals
  const onSignal = () => {
    shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Last-resort crash handlers — best-effort cleanup on unhandled errors
  const onCrash = (err: unknown) => {
    log.fatal("CRASH", { error: err instanceof Error ? err.message : String(err) });
    // Best-effort: kill all known child processes
    for (const session of pool.listSessions()) {
      killProcessGroup(session.pid);
    }
    removePidFile();
    process.exit(1);
  };
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  return { config, pool, channels, memoryManager: memoryManager ?? undefined, cronService, subagentRegistry, shutdown };
}

function writePidFile(): void {
  writeFileSync(paths.pidFile, String(process.pid), "utf-8");
}

function removePidFile(): void {
  try {
    unlinkSync(paths.pidFile);
  } catch {
    // Ignore
  }
}

export function readPidFile(): number | null {
  if (!existsSync(paths.pidFile)) return null;
  const content = readFileSync(paths.pidFile, "utf-8").trim();
  const pid = Number(content);
  if (Number.isNaN(pid)) return null;

  // Check if process is alive
  try {
    process.kill(pid, 0);
    return pid;
  } catch {
    // Process is dead, clean up stale PID file
    removePidFile();
    return null;
  }
}
