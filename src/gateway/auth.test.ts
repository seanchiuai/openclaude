import { describe, it, expect, vi, afterEach } from "vitest";
import { Hono } from "hono";
import { createAuthMiddleware } from "./auth.js";
import type { AuthMiddlewareResult } from "./auth.js";

function buildApp(authResult: AuthMiddlewareResult) {
  const app = new Hono();
  app.use("/api/*", authResult.middleware);
  app.get("/api/status", (c) => c.json({ ok: true }));
  app.get("/health", (c) => c.json({ ok: true }));
  return app;
}

describe("createAuthMiddleware", () => {
  let authResult: AuthMiddlewareResult;

  afterEach(() => {
    authResult?.rateLimiter?.dispose();
  });

  it("mode none passes all requests through", async () => {
    authResult = createAuthMiddleware({ mode: "none" });
    const app = buildApp(authResult);

    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("mode token returns 401 when no Authorization header", async () => {
    authResult = createAuthMiddleware({ mode: "token", token: "secret-123" });
    const app = buildApp(authResult);

    const res = await app.request("/api/status");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toContain("Authorization header required");
  });

  it("mode token returns 401 for wrong token", async () => {
    authResult = createAuthMiddleware({ mode: "token", token: "secret-123" });
    const app = buildApp(authResult);

    const res = await app.request("/api/status", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toContain("Invalid token");
  });

  it("mode token returns 200 for correct token", async () => {
    authResult = createAuthMiddleware({ mode: "token", token: "secret-123" });
    const app = buildApp(authResult);

    const res = await app.request("/api/status", {
      headers: { Authorization: "Bearer secret-123" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("rate limits after too many failed attempts", async () => {
    authResult = createAuthMiddleware({
      mode: "token",
      token: "secret-123",
      rateLimit: { maxAttempts: 2, windowMs: 60_000, lockoutMs: 300_000 },
    });
    const app = buildApp(authResult);

    // Two failures to trigger lockout
    for (let i = 0; i < 2; i++) {
      await app.request("/api/status", {
        headers: {
          Authorization: "Bearer wrong",
          "X-Forwarded-For": "10.0.0.1",
        },
      });
    }

    // Next request should be rate limited
    const res = await app.request("/api/status", {
      headers: {
        Authorization: "Bearer wrong",
        "X-Forwarded-For": "10.0.0.1",
      },
    });
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error).toContain("Too many failed attempts");
  });

  it("returns 500 when token mode is set but no token configured", async () => {
    // Ensure env var is not set
    const saved = process.env.OPENCLAUDE_GATEWAY_TOKEN;
    delete process.env.OPENCLAUDE_GATEWAY_TOKEN;

    try {
      authResult = createAuthMiddleware({ mode: "token" });
      const app = buildApp(authResult);

      const res = await app.request("/api/status", {
        headers: { Authorization: "Bearer anything" },
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain("misconfigured");
    } finally {
      if (saved !== undefined) {
        process.env.OPENCLAUDE_GATEWAY_TOKEN = saved;
      }
    }
  });

  it("falls back to OPENCLAUDE_GATEWAY_TOKEN env var", async () => {
    const saved = process.env.OPENCLAUDE_GATEWAY_TOKEN;
    process.env.OPENCLAUDE_GATEWAY_TOKEN = "env-secret";

    try {
      authResult = createAuthMiddleware({ mode: "token" });
      const app = buildApp(authResult);

      const res = await app.request("/api/status", {
        headers: { Authorization: "Bearer env-secret" },
      });
      expect(res.status).toBe(200);
    } finally {
      if (saved !== undefined) {
        process.env.OPENCLAUDE_GATEWAY_TOKEN = saved;
      } else {
        delete process.env.OPENCLAUDE_GATEWAY_TOKEN;
      }
    }
  });
});
