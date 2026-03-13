/**
 * Contract tests for gateway/http.ts
 *
 * Module under test: createGatewayApp, startHttpServer
 *
 * Dependencies (all mocked):
 * - pool (GatewayContext.pool) — mock with vi.fn() methods
 *
 * Testing strategy:
 * - Use app.request() to test the Hono app directly, no real HTTP server needed.
 *
 * Contracts verified:
 * 1. GET /health → 200 with { ok: true, uptime: number }
 * 2. GET /healthz → 200 with { ok: true, uptime: number }
 * 3. GET /ready → 200 with { ready: true, channels: [...], pool: stats }
 * 4. GET /api/status → 200 with uptime, channels, pool stats, sessions
 * 5. Unknown route GET /unknown → 404
 * 6. Pool stats reflected in responses
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGatewayApp } from "./http.js";
import type { GatewayContext } from "./http.js";

function createMockPool() {
  return {
    stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
    listSessions: vi.fn().mockReturnValue([]),
    submit: vi.fn(),
    drain: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
  };
}

function createCtx(overrides?: Partial<GatewayContext>): GatewayContext {
  return {
    pool: createMockPool() as unknown as GatewayContext["pool"],
    startedAt: Date.now() - 5000, // 5 seconds ago
    channels: ["telegram"],
    ...overrides,
  };
}

describe("createGatewayApp", () => {
  let ctx: GatewayContext;
  let app: ReturnType<typeof createGatewayApp>;

  beforeEach(() => {
    ctx = createCtx();
    app = createGatewayApp(ctx);
  });

  it("GET /health returns 200 with ok and uptime", async () => {
    const response = await app.request("/health");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("GET /healthz returns 200 with ok and uptime", async () => {
    const response = await app.request("/healthz");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ok).toBe(true);
    expect(typeof body.uptime).toBe("number");
  });

  it("GET /ready returns 200 with ready, channels, and pool stats", async () => {
    const response = await app.request("/ready");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.ready).toBe(true);
    expect(body.channels).toEqual(["telegram"]);
    expect(body.pool).toEqual({ running: 0, queued: 0, maxConcurrent: 4 });
  });

  it("GET /api/status returns 200 with uptime, channels, pool, sessions", async () => {
    const mockPool = ctx.pool as unknown as ReturnType<typeof createMockPool>;
    mockPool.listSessions.mockReturnValue([
      { id: "sess-1", status: "running", startedAt: Date.now(), pid: 1234 },
    ]);

    const response = await app.request("/api/status");
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(typeof body.uptime).toBe("number");
    expect(body.channels).toEqual(["telegram"]);
    expect(body.pool).toEqual({ running: 0, queued: 0, maxConcurrent: 4 });
    expect(body.sessions).toHaveLength(1);
    expect(body.sessions[0]).toEqual(
      expect.objectContaining({ id: "sess-1", status: "running", pid: 1234 }),
    );
  });

  it("GET /unknown returns 404", async () => {
    const response = await app.request("/unknown");
    expect(response.status).toBe(404);
  });

  it("returns 413 for oversized request body", async () => {
    const response = await app.request("/api/status", {
      method: "GET",
      headers: { "Content-Length": "2000000" },
    });
    expect(response.status).toBe(413);
    const body = await response.json();
    expect(body.error).toContain("Payload too large");
  });

  it("pool stats are reflected in responses", async () => {
    const mockPool = ctx.pool as unknown as ReturnType<typeof createMockPool>;
    mockPool.stats.mockReturnValue({ running: 3, queued: 2, maxConcurrent: 4 });

    const readyRes = await app.request("/ready");
    const readyBody = await readyRes.json();
    expect(readyBody.pool).toEqual({ running: 3, queued: 2, maxConcurrent: 4 });

    const statusRes = await app.request("/api/status");
    const statusBody = await statusRes.json();
    expect(statusBody.pool).toEqual({
      running: 3,
      queued: 2,
      maxConcurrent: 4,
    });
  });
});
