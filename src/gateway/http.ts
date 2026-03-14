/**
 * Hono HTTP server for the gateway.
 *
 * Provides health/readiness endpoints and API surface for MCP tool access.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { open, stat } from "node:fs/promises";
import { paths } from "../config/paths.js";
import type { ProcessPool } from "../engine/pool.js";
import type { CronService } from "../cron/index.js";
import type { MemorySearchManager } from "../memory/index.js";
import type { ChannelAdapter } from "../channels/types.js";
import type { SubagentRegistry, SubagentRun } from "../engine/subagent-registry.js";

/** Safely parse JSON body, returning a Zod-validated result or a 400 error response. */
function parseBody<T>(schema: z.ZodType<T>) {
  return async (c: { req: { json: () => Promise<unknown> } }) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return { ok: false as const, error: "Invalid JSON body" };
    }
    const result = schema.safeParse(raw);
    if (!result.success) {
      return { ok: false as const, error: result.error.issues.map((i) => i.message).join("; ") };
    }
    return { ok: true as const, data: result.data };
  };
}

// --- Zod schemas for API request bodies ---

const CronAddBody = z.object({
  name: z.string(),
  schedule: z.object({
    kind: z.enum(["cron", "every", "at"]),
    expr: z.string().optional(),
    timezone: z.string().optional(),
    atMs: z.number().optional(),
    everyMs: z.number().optional(),
    anchorMs: z.number().optional(),
  }),
  prompt: z.string(),
  target: z.object({
    channel: z.enum(["telegram", "slack"]),
    chatId: z.string(),
  }).optional(),
});

const IdBody = z.object({ id: z.string() });

const MemorySearchBody = z.object({
  query: z.string(),
  maxResults: z.number().optional(),
  minScore: z.number().optional(),
});

const MemoryGetBody = z.object({
  path: z.string(),
  from: z.number().optional(),
  lines: z.number().optional(),
});

const SendBody = z.object({
  channel: z.string(),
  chatId: z.string(),
  text: z.string(),
});

const LogsTailBody = z.object({
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(5000).optional(),
  maxBytes: z.number().int().min(1).max(1_000_000).optional(),
  level: z.enum(["error", "warn", "info", "debug"]).optional(),
});

const SubagentSpawnBody = z.object({
  task: z.string().min(1),
  label: z.string().optional(),
  model: z.string().optional(),
  timeoutSeconds: z.number().min(10).max(3600).optional(),
  callerSessionId: z.string().optional(),
});

const SubagentStatusBody = z.object({
  callerSessionId: z.string().optional(),
});

export interface GatewayContext {
  pool: ProcessPool;
  startedAt: number;
  channels: string[];
  cronService?: CronService;
  memoryManager?: MemorySearchManager;
  channelAdapters?: Map<string, ChannelAdapter>;
  authMiddleware?: (c: import("hono").Context, next: import("hono").Next) => Promise<Response | void>;
  subagentRegistry?: SubagentRegistry;
  onSubagentSpawn?: (run: SubagentRun) => void;
}

const DEFAULT_LOG_LIMIT = 500;
const DEFAULT_LOG_MAX_BYTES = 250_000;
const MAX_LOG_LIMIT = 5000;
const MAX_LOG_BYTES = 1_000_000;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

async function readLogSlice(params: {
  file: string;
  cursor?: number;
  limit: number;
  maxBytes: number;
}): Promise<{
  file: string;
  cursor: number;
  size: number;
  lines: string[];
  truncated: boolean;
  reset: boolean;
}> {
  const fileStat = await stat(params.file).catch(() => null);
  if (!fileStat) {
    return { file: params.file, cursor: 0, size: 0, lines: [], truncated: false, reset: false };
  }

  const size = fileStat.size;
  const maxBytes = clamp(params.maxBytes, 1, MAX_LOG_BYTES);
  const limit = clamp(params.limit, 1, MAX_LOG_LIMIT);
  let cursor = typeof params.cursor === "number" && Number.isFinite(params.cursor)
    ? Math.max(0, Math.floor(params.cursor))
    : undefined;
  let reset = false;
  let truncated = false;
  let start = 0;

  if (cursor != null) {
    if (cursor > size) {
      // Log was likely rotated/truncated — reset to tail
      reset = true;
      start = Math.max(0, size - maxBytes);
      truncated = start > 0;
    } else {
      start = cursor;
      if (size - start > maxBytes) {
        reset = true;
        truncated = true;
        start = Math.max(0, size - maxBytes);
      }
    }
  } else {
    // No cursor: read from tail
    start = Math.max(0, size - maxBytes);
    truncated = start > 0;
  }

  if (size === 0 || size <= start) {
    return { file: params.file, cursor: size, size, lines: [], truncated, reset };
  }

  const handle = await open(params.file, "r");
  try {
    // If starting mid-file, check if we're at a line boundary
    let prefix = "";
    if (start > 0) {
      const prefixBuf = Buffer.alloc(1);
      const prefixRead = await handle.read(prefixBuf, 0, 1, start - 1);
      prefix = prefixBuf.toString("utf8", 0, prefixRead.bytesRead);
    }

    const length = Math.max(0, size - start);
    const buffer = Buffer.alloc(length);
    const readResult = await handle.read(buffer, 0, length, start);
    const text = buffer.toString("utf8", 0, readResult.bytesRead);
    let lines = text.split("\n");

    // Drop partial first line if we started mid-line
    if (start > 0 && prefix !== "\n") {
      lines = lines.slice(1);
    }
    // Drop trailing empty line from final newline
    if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines = lines.slice(0, -1);
    }
    // Keep only the last `limit` lines
    if (lines.length > limit) {
      lines = lines.slice(lines.length - limit);
    }

    return { file: params.file, cursor: size, size, lines, truncated, reset };
  } finally {
    await handle.close();
  }
}

const MAX_BODY_BYTES = 1_048_576; // 1 MB

export function createGatewayApp(ctx: GatewayContext) {
  const app = new Hono();

  // Body size limit for API routes
  app.use("/api/*", async (c, next) => {
    const cl = c.req.header("content-length");
    if (cl && parseInt(cl, 10) > MAX_BODY_BYTES) {
      return c.json({ error: "Payload too large" }, 413);
    }
    await next();
  });

  // Auth middleware for API routes
  if (ctx.authMiddleware) {
    app.use("/api/*", ctx.authMiddleware);
  }

  // Liveness probe
  app.get("/health", (c) =>
    c.json({ ok: true, uptime: Date.now() - ctx.startedAt }),
  );

  app.get("/healthz", (c) =>
    c.json({ ok: true, uptime: Date.now() - ctx.startedAt }),
  );

  // Readiness probe
  app.get("/ready", (c) => {
    const stats = ctx.pool.stats();
    return c.json({
      ready: true,
      channels: ctx.channels,
      pool: stats,
    });
  });

  app.get("/readyz", (c) => {
    return c.json({ ready: true });
  });

  // Pool status
  app.get("/api/status", (c) => {
    const stats = ctx.pool.stats();
    const sessions = ctx.pool.listSessions().map((s) => ({
      id: s.id,
      status: s.status,
      startedAt: s.startedAt,
      pid: s.pid,
    }));

    return c.json({
      uptime: Date.now() - ctx.startedAt,
      channels: ctx.channels,
      pool: stats,
      sessions,
    });
  });

  // --- Cron API ---

  app.post("/api/cron/list", (c) => {
    if (!ctx.cronService) return c.json({ error: "Cron service not available" }, 503);
    const jobs = ctx.cronService.list();
    return c.json({ ok: true, jobs });
  });

  app.post("/api/cron/status", (c) => {
    if (!ctx.cronService) return c.json({ error: "Cron service not available" }, 503);
    const status = ctx.cronService.status();
    return c.json({ ok: true, ...status });
  });

  app.post("/api/cron/add", async (c) => {
    if (!ctx.cronService) return c.json({ error: "Cron service not available" }, 503);
    const parsed = await parseBody(CronAddBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const job = ctx.cronService.add(parsed.data);
    return c.json({ ok: true, job });
  });

  app.post("/api/cron/remove", async (c) => {
    if (!ctx.cronService) return c.json({ error: "Cron service not available" }, 503);
    const parsed = await parseBody(IdBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const removed = ctx.cronService.remove(parsed.data.id);
    return c.json({ ok: true, removed });
  });

  app.post("/api/cron/run", async (c) => {
    if (!ctx.cronService) return c.json({ error: "Cron service not available" }, 503);
    const parsed = await parseBody(IdBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const outcome = await ctx.cronService.run(parsed.data.id);
    return c.json({ ok: true, ...outcome });
  });

  // --- Memory API ---

  app.post("/api/memory/search", async (c) => {
    if (!ctx.memoryManager) return c.json({ error: "Memory not available" }, 503);
    const parsed = await parseBody(MemorySearchBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const results = await ctx.memoryManager.search(parsed.data.query, {
      maxResults: parsed.data.maxResults,
      minScore: parsed.data.minScore,
    });
    return c.json({ ok: true, results });
  });

  app.post("/api/memory/get", async (c) => {
    if (!ctx.memoryManager) return c.json({ error: "Memory not available" }, 503);
    const parsed = await parseBody(MemoryGetBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    try {
      const result = await ctx.memoryManager.readFile({ relPath: parsed.data.path, from: parsed.data.from, lines: parsed.data.lines });
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // --- Send API ---

  app.post("/api/send", async (c) => {
    if (!ctx.channelAdapters) return c.json({ error: "No channels available" }, 503);
    const parsed = await parseBody(SendBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    const adapter = ctx.channelAdapters.get(parsed.data.channel);
    if (!adapter) {
      return c.json({ error: `Channel not found: ${parsed.data.channel}` }, 404);
    }
    try {
      const result = await adapter.sendText(parsed.data.chatId, parsed.data.text);
      return c.json({ ok: true, messageId: result.messageId });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- Logs API ---

  app.get("/api/logs/tail", async (c) => {
    const cursor = c.req.query("cursor");
    const limit = c.req.query("limit");
    const maxBytes = c.req.query("maxBytes");
    const level = c.req.query("level");

    const parsed = LogsTailBody.safeParse({
      cursor: cursor != null ? Number(cursor) : undefined,
      limit: limit != null ? Number(limit) : undefined,
      maxBytes: maxBytes != null ? Number(maxBytes) : undefined,
      level: level || undefined,
    });
    if (!parsed.success) {
      return c.json({ error: parsed.error.issues.map((i) => i.message).join("; ") }, 400);
    }

    const p = parsed.data;
    try {
      const result = await readLogSlice({
        file: paths.logFile,
        cursor: p.cursor,
        limit: p.limit ?? DEFAULT_LOG_LIMIT,
        maxBytes: p.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
      });

      // Optional level filtering — applied after reading
      if (p.level) {
        const levelPriority: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
        const threshold = levelPriority[p.level] ?? 3;
        result.lines = result.lines.filter((line) => {
          // Try to parse as JSON log line and check level
          try {
            const entry = JSON.parse(line);
            const entryLevel = (entry.level ?? "info").toLowerCase();
            return (levelPriority[entryLevel] ?? 3) <= threshold;
          } catch {
            // Non-JSON lines pass through (e.g. stderr captures)
            return true;
          }
        });
      }

      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post("/api/logs/tail", async (c) => {
    const parsed = await parseBody(LogsTailBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const p = parsed.data;
    try {
      const result = await readLogSlice({
        file: paths.logFile,
        cursor: p.cursor,
        limit: p.limit ?? DEFAULT_LOG_LIMIT,
        maxBytes: p.maxBytes ?? DEFAULT_LOG_MAX_BYTES,
      });

      if (p.level) {
        const levelPriority: Record<string, number> = { error: 0, warn: 1, info: 2, debug: 3 };
        const threshold = levelPriority[p.level] ?? 3;
        result.lines = result.lines.filter((line) => {
          try {
            const entry = JSON.parse(line);
            const entryLevel = (entry.level ?? "info").toLowerCase();
            return (levelPriority[entryLevel] ?? 3) <= threshold;
          } catch {
            return true;
          }
        });
      }

      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // --- Subagent API ---
  const MAX_CHILDREN_PER_PARENT = 4;

  app.post("/api/subagent/spawn", async (c) => {
    if (!ctx.subagentRegistry) return c.json({ error: "Subagent system not available" }, 503);
    const parsed = await parseBody(SubagentSpawnBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const callerSessionId = parsed.data.callerSessionId ?? "";

    // Reject spawns from child sessions (API-level enforcement)
    if (callerSessionId.startsWith("sub-")) {
      return c.json({ error: "Child sessions cannot spawn subagents" }, 403);
    }

    const active = ctx.subagentRegistry.getActiveRunsForParent(callerSessionId);
    if (active.length >= MAX_CHILDREN_PER_PARENT) {
      return c.json({ error: `Max ${MAX_CHILDREN_PER_PARENT} concurrent children per parent` }, 429);
    }

    const runId = crypto.randomUUID();
    const childSessionId = `sub-${crypto.randomUUID().slice(0, 8)}`;
    const run: SubagentRun = {
      runId,
      parentSessionKey: callerSessionId,
      parentSessionId: callerSessionId,
      childSessionId,
      task: parsed.data.task,
      label: parsed.data.label,
      model: parsed.data.model,
      timeoutSeconds: parsed.data.timeoutSeconds,
      status: "queued",
      createdAt: Date.now(),
    };
    ctx.subagentRegistry.register(run);
    ctx.onSubagentSpawn?.(run);

    return c.json({ ok: true, runId, childSessionId, status: "accepted" });
  });

  app.post("/api/subagent/status", async (c) => {
    if (!ctx.subagentRegistry) return c.json({ error: "Subagent system not available" }, 503);
    const parsed = await parseBody(SubagentStatusBody)(c);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);

    const callerSessionId = parsed.data.callerSessionId ?? "";
    const runs = ctx.subagentRegistry.getRunsForParent(callerSessionId).map((r) => ({
      runId: r.runId,
      childSessionId: r.childSessionId,
      task: r.label ?? r.task,
      status: r.status,
      duration: r.duration,
      createdAt: r.createdAt,
    }));
    return c.json({ ok: true, runs });
  });

  return app;
}

export function startHttpServer(
  app: Hono,
  port: number,
): ReturnType<typeof serve> {
  return serve({ fetch: app.fetch, port });
}
