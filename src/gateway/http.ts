/**
 * Hono HTTP server for the gateway.
 * Extracted and simplified from OpenClaw's gateway/server-http.ts.
 *
 * Provides health/readiness endpoints and future API surface.
 */
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { ProcessPool } from "../engine/pool.js";

export interface GatewayContext {
  pool: ProcessPool;
  startedAt: number;
  channels: string[];
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

  return app;
}

export function startHttpServer(
  app: Hono,
  port: number,
): ReturnType<typeof serve> {
  return serve({ fetch: app.fetch, port });
}
