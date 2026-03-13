/**
 * Diagnostic heartbeat for the OpenClaude gateway.
 *
 * Logs system health every 30 seconds when there's activity.
 * Detects stuck sessions (>2 min in "running" state).
 * Simplified from OpenClaw's diagnostic.ts.
 */
import { createLogger } from "./logger.js";
import type { ProcessPool } from "../engine/pool.js";
import type { CronService } from "../cron/index.js";

const log = createLogger("diagnostic");

const HEARTBEAT_INTERVAL_MS = 30_000;
const STUCK_SESSION_WARN_MS = 120_000; // 2 minutes
const IDLE_SKIP_MS = 120_000; // skip heartbeat if idle > 2 min

let interval: ReturnType<typeof setInterval> | null = null;
let lastActivityAt = 0;

/** Mark that something happened (message received, job ran, etc.). */
export function markActivity(): void {
  lastActivityAt = Date.now();
}

export interface DiagnosticContext {
  pool: ProcessPool;
  cronService?: CronService;
  startedAt: number;
}

export function startDiagnosticHeartbeat(ctx: DiagnosticContext): void {
  if (interval) return; // Already running

  interval = setInterval(() => {
    const now = Date.now();
    const poolStats = ctx.pool.stats();
    const sessions = ctx.pool.listSessions();

    // Skip if no activity and nothing running for > 2 min
    const hasActivity = poolStats.running > 0 || poolStats.queued > 0;
    if (!hasActivity && now - lastActivityAt > IDLE_SKIP_MS) {
      return;
    }

    // Detect stuck sessions
    const stuckSessions: Array<{ id: string; ageMs: number }> = [];
    for (const session of sessions) {
      if (session.status === "running" && session.startedAt) {
        const ageMs = now - session.startedAt;
        if (ageMs > STUCK_SESSION_WARN_MS) {
          stuckSessions.push({ id: session.id, ageMs });
        }
      }
    }

    // Log stuck sessions as warnings
    for (const stuck of stuckSessions) {
      log.warn("Session stuck", {
        sessionId: stuck.id,
        ageMs: stuck.ageMs,
        ageSec: Math.round(stuck.ageMs / 1000),
      });
    }

    // Memory usage
    const mem = process.memoryUsage();

    // Cron stats
    const cronStats = ctx.cronService?.status();

    log.info("heartbeat", {
      uptimeSec: Math.round((now - ctx.startedAt) / 1000),
      pool: {
        running: poolStats.running,
        queued: poolStats.queued,
        max: poolStats.maxConcurrent,
      },
      sessions: sessions.length,
      stuckSessions: stuckSessions.length,
      cron: cronStats ? {
        running: cronStats.running,
        jobs: cronStats.jobCount,
        enabled: cronStats.enabledCount,
      } : undefined,
      memory: {
        heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024),
        rssMB: Math.round(mem.rss / 1024 / 1024),
      },
    });
  }, HEARTBEAT_INTERVAL_MS);

  // Don't prevent process exit
  interval.unref?.();

  log.info("Diagnostic heartbeat started", { intervalMs: HEARTBEAT_INTERVAL_MS });
}

export function stopDiagnosticHeartbeat(): void {
  if (interval) {
    clearInterval(interval);
    interval = null;
  }
}
