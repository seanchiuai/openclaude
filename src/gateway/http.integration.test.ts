import { describe, it, expect, beforeEach } from "vitest";
import { createGatewayApp } from "./http.js";
import { createProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("gateway HTTP integration", () => {
  const ctx = createTestContext("gateway");
  let app: ReturnType<typeof createGatewayApp>;
  let pool: ReturnType<typeof createProcessPool>;

  beforeEach(() => {
    pool = createProcessPool(2);
    app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
    });
    ctx.dumpOnFailure();
  });

  it("health endpoint returns 200 without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("healthz alias also works", async () => {
    const res = await app.request("/healthz");
    expect(res.status).toBe(200);
  });

  it("readiness endpoint returns 200", async () => {
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
  });

  it("status endpoint shows pool stats without auth when no authMiddleware", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pool).toBeDefined();
    expect(body.pool.running).toBe(0);
    expect(body.pool.queued).toBe(0);
    expect(body.pool.maxConcurrent).toBe(2);
  });

  it("auth middleware blocks unauthorized requests", async () => {
    const authedApp = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
      authMiddleware: async (c, next) => {
        const auth = c.req.header("Authorization");
        if (auth !== "Bearer test-token") {
          return c.json({ error: "unauthorized" }, 401);
        }
        await next();
      },
    });

    const noAuth = await authedApp.request("/api/status");
    expect(noAuth.status).toBe(401);

    const withAuth = await authedApp.request("/api/status", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(withAuth.status).toBe(200);
  });

  it("health endpoints bypass auth middleware", async () => {
    const authedApp = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
      authMiddleware: async (c, next) => {
        const auth = c.req.header("Authorization");
        if (auth !== "Bearer test-token") {
          return c.json({ error: "unauthorized" }, 401);
        }
        await next();
      },
    });

    // Health should work without auth even when auth middleware is set
    const health = await authedApp.request("/health");
    expect(health.status).toBe(200);
  });
});
