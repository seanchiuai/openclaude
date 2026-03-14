import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGatewayApp, startHttpServer } from "../gateway/http.js";
import { createProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";
import { createTestEnv } from "../../test/helpers/config.js";
import { createCleanupRegistry } from "../../test/helpers/cleanup.js";
import type { AddressInfo } from "node:net";

describe("system integration: full gateway", () => {
  const ctx = createTestContext("system");
  const cleanup = createCleanupRegistry();
  let baseUrl: string;
  let pool: ReturnType<typeof createProcessPool>;
  let server: ReturnType<typeof startHttpServer>;

  beforeAll(async () => {
    const testEnv = await createTestEnv();
    cleanup.trackDir(testEnv.dir);

    pool = createProcessPool(2);
    const app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
    });

    server = startHttpServer(app, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    ctx.log(`system test gateway on ${baseUrl}`);

    cleanup.onCleanup(async () => {
      server.close();
      await pool.drain();
    });
  }, 15_000);

  afterAll(async () => {
    await cleanup.runAll();
  });

  it("health check via real HTTP", async () => {
    ctx.dumpOnFailure();
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    ctx.log("health OK");
  });

  it("status via real HTTP", async () => {
    ctx.dumpOnFailure();
    const res = await fetch(`${baseUrl}/api/status`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pool.running).toBe(0);
    expect(body.pool.maxConcurrent).toBe(2);
    ctx.log("status OK", body);
  });

  it("real TCP fetch works (not just app.request)", async () => {
    ctx.dumpOnFailure();
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("concurrent health checks don't crash", async () => {
    ctx.dumpOnFailure();
    const requests = Array.from({ length: 10 }, () =>
      fetch(`${baseUrl}/health`).then((r) => r.status),
    );
    const statuses = await Promise.all(requests);
    expect(statuses.every((s) => s === 200)).toBe(true);
    ctx.log("10 concurrent health checks OK");
  });
});
