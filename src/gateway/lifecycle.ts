/**
 * Gateway lifecycle management.
 * Handles startup, shutdown, and signal handling.
 */
import { writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { paths } from "../config/paths.js";
import { ensureDirectories, loadConfig } from "../config/loader.js";
import { createProcessPool } from "../engine/pool.js";
import { createGatewayApp, startHttpServer } from "./http.js";
import { createRouter } from "../router/index.js";
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

export interface Gateway {
  config: OpenClaudeConfig;
  pool: ProcessPool;
  channels: Map<string, ChannelAdapter>;
  memoryManager?: MemoryManager;
  cronService?: CronService;
  shutdown: () => Promise<void>;
}

const DEFAULT_PORT = 45557;

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

  // Cron service
  let cronService: CronService | undefined;
  if (config.cron.enabled) {
    cronService = createCronService({
      storePath: config.cron.storePath,
      runIsolatedJob: async (job) => {
        const sessionId = `cron-${job.id}-${Date.now()}`;
        try {
          const result = await pool.submit({ sessionId, prompt: job.prompt, timeout: 300_000 });
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
            const result = await pool.submit({ sessionId, prompt, timeout: 300_000 });
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

  // Router returns response text — the channel bot sends it back directly
  const router = createRouter({ pool, memoryManager, cronService });

  // Start HTTP server
  const app = createGatewayApp({
    pool,
    startedAt: Date.now(),
    channels: channelNames,
  });
  const server = startHttpServer(app, DEFAULT_PORT);

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
    console.error("[gateway] Slack channel started");
  }

  // Write PID file
  writePidFile();

  console.error(`[gateway] Started on port ${DEFAULT_PORT}`);
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
