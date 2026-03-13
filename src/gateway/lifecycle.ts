/**
 * Gateway lifecycle management.
 * Handles startup, shutdown, and signal handling.
 */
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { paths } from "../config/paths.js";
import { ensureDirectories, loadConfig } from "../config/loader.js";
import { createProcessPool } from "../engine/pool.js";
import { createGatewayApp, startHttpServer } from "./http.js";
import { createAuthMiddleware } from "./auth.js";
import { createRouter } from "../router/index.js";
import { loadSkills } from "../skills/index.js";
import { sweepStaleSessions } from "../engine/session-cleanup.js";
import { cleanStaleGatewayProcessesSync } from "../engine/orphan-reaper.js";
import { killProcessGroup } from "../engine/spawn.js";
import { createMemoryManager } from "../memory/index.js";
import { createCronService } from "../cron/index.js";
import { createHeartbeatRunner } from "../cron/heartbeat.js";
import type { OpenClaudeConfig } from "../config/types.js";
import type { ProcessPool } from "../engine/pool.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/index.js";
import type { HeartbeatRunner } from "../cron/heartbeat.js";
import type { CronDeliveryTarget } from "../cron/types.js";
import type { OnStreamEvent } from "../engine/types.js";
import { createStreamingReply } from "../channels/streaming.js";

export interface Gateway {
  config: OpenClaudeConfig;
  pool: ProcessPool;
  channels: Map<string, ChannelAdapter>;
  memoryManager?: MemoryManager;
  cronService?: CronService;
  shutdown: () => Promise<void>;
}

export async function startGateway(configPath?: string): Promise<Gateway> {
  ensureDirectories();

  const config = loadConfig(configPath);
  const pool = createProcessPool(config.agent.maxConcurrent);
  const channels = new Map<string, ChannelAdapter>();
  const channelNames: string[] = [];

  // Create memory manager
  const memoryManager = createMemoryManager({
    dbPath: paths.memoryDb,
    workspaceDir: paths.base,
  });

  // Fire-and-forget initial memory sync
  memoryManager.sync().catch((err: unknown) => {
    console.error("[gateway] Initial memory sync failed:", err instanceof Error ? err.message : String(err));
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
    console.error(`[gateway] Reaped ${reaped.length} stale process(es) from previous run`);
  }

  const gatewayUrl = `http://localhost:${gatewayPort}`;

  // Resolve gateway token for auth
  const gatewayToken = config.gateway.auth.mode === "token"
    ? (config.gateway.auth.token ?? process.env.OPENCLAUDE_GATEWAY_TOKEN)
    : undefined;

  // Sweep stale session directories on startup
  const sweepResult = sweepStaleSessions(paths.sessions);
  if (sweepResult.removed.length > 0) {
    console.error(`[gateway] Cleaned ${sweepResult.removed.length} stale session(s)`);
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
    });
    cronService.start();
    console.error("[gateway] Cron service started");
  }

  // Heartbeat runner
  let heartbeat: HeartbeatRunner | undefined;
  if (config.heartbeat.enabled) {
    heartbeat = createHeartbeatRunner(
      {
        enabled: true,
        every: config.heartbeat.every,
        checklistPath: paths.heartbeat,
        target: config.heartbeat.target,
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
    console.error("[gateway] Heartbeat started");
  }

  // Load skills from ~/.openclaude/skills/
  const skills = await loadSkills(paths.skills);
  if (skills.length > 0) {
    console.error(`[gateway] Loaded ${skills.length} skill(s): ${skills.map((s) => s.name).join(", ")}`);
  }

  // Router returns response text — the channel bot sends it back directly
  const router = createRouter({ pool, memoryManager, cronService, skills, mcpConfig: config.mcp, gatewayUrl, gatewayToken });

  // Create auth middleware
  const authResult = createAuthMiddleware(config.gateway.auth);

  // Start HTTP server
  const app = createGatewayApp({
    pool,
    startedAt: Date.now(),
    channels: channelNames,
    cronService,
    memoryManager,
    channelAdapters: channels,
    authMiddleware: authResult.middleware,
  });
  const server = startHttpServer(app, gatewayPort);

  // Start Telegram if configured
  if (config.channels.telegram?.enabled) {
    const { createTelegramChannel } = await import(
      "../channels/telegram/index.js"
    );

    const telegram = createTelegramChannel(config.channels.telegram, async (msg) => {
      const reply = createStreamingReply({
        sendText: async (text) => telegram.sendText(msg.chatId, text),
        editMessage: async (msgId, text) => telegram.editMessage!(msg.chatId, msgId, text),
      });
      const onProgress: OnStreamEvent = (event) => {
        if (event.type === "text") reply.update(event.text);
        if (event.type === "status") reply.status(event.message);
        if (event.type === "queued") reply.status(`Waiting in queue (position ${event.position})...`);
      };
      const finalText = await router(msg, onProgress);
      if (!reply.failed()) {
        await reply.finalize(finalText);
        return ""; // Suppress withTypingAndReactions sendText (already streamed)
      }
      return finalText; // Fallback: withTypingAndReactions sends fresh
    });
    await telegram.start();
    channels.set("telegram", telegram);
    channelNames.push("telegram");
  }

  // Start Slack if configured
  if (config.channels.slack?.enabled) {
    const { createSlackChannel } = await import("../channels/slack/index.js");

    const slack = createSlackChannel(config.channels.slack, async (msg) => {
      const inbound = {
        channel: msg.channel,
        chatId: msg.chatId,
        userId: msg.userId,
        username: msg.username,
        text: msg.text,
        source: msg.source as "user" | "cron" | "system",
      };
      const reply = createStreamingReply({
        sendText: async (text) => slack.sendText(msg.chatId, text),
        editMessage: async (msgId, text) => slack.editMessage!(msg.chatId, msgId, text),
      });
      const onProgress: OnStreamEvent = (event) => {
        if (event.type === "text") reply.update(event.text);
        if (event.type === "status") reply.status(event.message);
        if (event.type === "queued") reply.status(`Waiting in queue (position ${event.position})...`);
      };
      const finalText = await router(inbound, onProgress);
      if (!reply.failed()) {
        await reply.finalize(finalText);
        return ""; // Already streamed
      }
      // Fallback: send normally
      if (finalText && msg.chatId) {
        await slack.sendText(msg.chatId, finalText);
      }
      return finalText;
    });
    await slack.start();
    channels.set("slack", slack);
    channelNames.push("slack");
    console.error("[gateway] Slack channel started");
  }

  // Write PID file
  writePidFile();

  console.error(`[gateway] Started on port ${gatewayPort}`);
  if (channelNames.length > 0) {
    console.error(`[gateway] Channels: ${channelNames.join(", ")}`);
  }

  const shutdown = async () => {
    console.error("[gateway] Shutting down...");

    // Stop heartbeat first
    if (heartbeat) {
      heartbeat.stop();
      console.error("[gateway] Heartbeat stopped");
    }

    // Stop cron
    if (cronService) {
      cronService.stop();
      console.error("[gateway] Cron service stopped");
    }

    // Close memory DB
    memoryManager.close();
    console.error("[gateway] Memory closed");

    // Stop channels
    for (const [name, channel] of channels) {
      try {
        await channel.stop();
        console.error(`[gateway] Stopped channel: ${name}`);
      } catch {
        // Best effort
      }
    }

    // Drain process pool
    await pool.drain();

    // Stop HTTP server
    server.close();

    // Remove PID file
    removePidFile();

    console.error("[gateway] Shutdown complete.");
  };

  // Graceful shutdown on signals
  const onSignal = () => {
    shutdown().then(() => process.exit(0));
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  // Last-resort crash handlers — best-effort cleanup on unhandled errors
  const onCrash = (err: unknown) => {
    console.error("[gateway] CRASH:", err instanceof Error ? err.message : String(err));
    // Best-effort: kill all known child processes
    for (const session of pool.listSessions()) {
      killProcessGroup(session.pid);
    }
    removePidFile();
    process.exit(1);
  };
  process.on("uncaughtException", onCrash);
  process.on("unhandledRejection", onCrash);

  return { config, pool, channels, memoryManager, cronService, shutdown };
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
