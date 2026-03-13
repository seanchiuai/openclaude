/**
 * Hono HTTP server for the gateway.
 *
 * Provides health/readiness endpoints and API surface for MCP tool access.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { z } from "zod";
import type { ProcessPool } from "../engine/pool.js";
import type { CronService } from "../cron/index.js";
import type { MemoryManager } from "../memory/index.js";
import type { ChannelAdapter } from "../channels/types.js";

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

export interface GatewayContext {
  pool: ProcessPool;
  startedAt: number;
  channels: string[];
  cronService?: CronService;
  memoryManager?: MemoryManager;
  channelAdapters?: Map<string, ChannelAdapter>;
}

export function createGatewayApp(ctx: GatewayContext) {
  const app = new Hono();

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
      const result = await ctx.memoryManager.readFile(parsed.data.path, parsed.data.from, parsed.data.lines);
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

  return app;
}

export function startHttpServer(
  app: Hono,
  port: number,
): ReturnType<typeof serve> {
  return serve({ fetch: app.fetch, port });
}
