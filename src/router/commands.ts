/**
 * Gateway command handlers.
 * These commands are handled directly without spawning Claude.
 */
import type { ProcessPool } from "../engine/pool.js";
import type { MemoryManager } from "../memory/index.js";
import type { CronService } from "../cron/index.js";
import type { ParsedCommand } from "./types.js";

export interface CommandDeps {
  pool: ProcessPool;
  memoryManager?: MemoryManager;
  cronService?: CronService;
}

export function createCommandHandlers(deps: CommandDeps) {
  const { pool, memoryManager, cronService } = deps;

  const handlers: Record<
    string,
    (cmd: ParsedCommand) => Promise<string>
  > = {
    list: async () => {
      const sessions = pool.listSessions();
      if (sessions.length === 0) {
        return "No active sessions.";
      }

      const lines = sessions.map((s) => {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        return `- ${s.id} [${s.status}] (${elapsed}s)`;
      });

      return `Active sessions:\n${lines.join("\n")}`;
    },

    stop: async (cmd) => {
      const sessionId = cmd.args.trim();
      if (!sessionId) {
        return "Usage: /stop <session-id>";
      }

      const killed = pool.killSession(sessionId);
      return killed
        ? `Session ${sessionId} stopped.`
        : `Session ${sessionId} not found.`;
    },

    status: async () => {
      const stats = pool.stats();
      return [
        "OpenClaude Status",
        `Running: ${stats.running}/${stats.maxConcurrent}`,
        `Queued: ${stats.queued}`,
      ].join("\n");
    },

    help: async () => {
      return [
        "OpenClaude Commands:",
        "/list - Show active sessions",
        "/stop <id> - Stop a session",
        "/status - Show system status",
        "/memory - Show memory status",
        "/memorysync - Force memory sync",
        "/cron - Manage cron jobs",
        "/skills - Show skills info",
        "/help - Show this message",
      ].join("\n");
    },

    memory: async (cmd) => {
      if (!memoryManager) {
        return "Memory system is not available.";
      }

      const s = memoryManager.status();
      return [
        "Memory Status",
        `Provider: ${s.provider}`,
        `Files: ${s.files}`,
        `Chunks: ${s.chunks}`,
        `FTS: ${s.fts.available ? "available" : "unavailable"}`,
        `Dirty: ${s.dirty}`,
        `DB: ${s.dbPath}`,
      ].join("\n");
    },

    memorysync: async () => {
      if (!memoryManager) {
        return "Memory system is not available.";
      }

      await memoryManager.sync({ force: true });
      return "Memory sync complete.";
    },

    skills: async () => {
      return "Use 'openclaude skills list' in the CLI to see loaded skills.";
    },

    cron: async (cmd) => {
      if (!cronService) {
        return "Cron system is not available.";
      }

      const subArgs = cmd.args.trim();
      const parts = subArgs.split(/\s+/);
      const sub = parts[0] || "list";

      if (sub === "list") {
        const jobs = cronService.list();
        if (jobs.length === 0) {
          return "No cron jobs.";
        }
        const lines = jobs.map((j) => {
          const status = j.enabled ? "enabled" : "disabled";
          const lastRun = j.state.lastRunAtMs
            ? new Date(j.state.lastRunAtMs).toISOString()
            : "never";
          return `- ${j.id} "${j.name}" [${status}] last: ${lastRun}`;
        });
        return `Cron jobs:\n${lines.join("\n")}`;
      }

      if (sub === "add") {
        return [
          "Usage: Add cron jobs via the API or config.",
          "Schedule formats:",
          '  { kind: "every", everyMs: 3600000 }',
          '  { kind: "cron", expr: "0 * * * *" }',
          '  { kind: "at", atMs: <timestamp> }',
        ].join("\n");
      }

      if (sub === "remove") {
        const id = parts[1];
        if (!id) {
          return "Usage: /cron remove <id>";
        }
        const removed = cronService.remove(id);
        return removed ? `Job ${id} removed.` : `Job ${id} not found.`;
      }

      if (sub === "run") {
        const id = parts[1];
        if (!id) {
          return "Usage: /cron run <id>";
        }
        const outcome = await cronService.run(id);
        if (outcome.status === "ok") {
          return `Job ${id} completed: ${outcome.summary ?? "ok"}`;
        }
        return `Job ${id} ${outcome.status}: ${outcome.error ?? "unknown"}`;
      }

      return "Unknown cron subcommand. Try: list, add, remove <id>, run <id>";
    },
  };

  return handlers;
}

export const GATEWAY_COMMANDS = new Set([
  "list",
  "stop",
  "status",
  "help",
  "memory",
  "memorysync",
  "skills",
  "cron",
]);
