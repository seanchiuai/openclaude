/**
 * Tests for the /api/logs/tail endpoint.
 *
 * Uses vi.mock to redirect paths.logFile to a temp file.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logDir = join(tmpdir(), `openclaude-logs-test-${process.pid}`);
const logFile = join(logDir, "gateway.log");

vi.mock("../config/paths.js", () => ({
  paths: {
    logFile,
  },
}));

// Import after mock is set up
const { createGatewayApp } = await import("./http.js");
type GatewayContext = Parameters<typeof createGatewayApp>[0];

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

function createCtx(): GatewayContext {
  return {
    pool: createMockPool() as unknown as GatewayContext["pool"],
    startedAt: Date.now() - 5000,
    channels: ["telegram"],
  };
}

const LOG_LINES = [
  JSON.stringify({ level: "info", message: "server started", time: "2026-03-13T00:00:00Z" }),
  JSON.stringify({ level: "error", message: "connection failed", time: "2026-03-13T00:01:00Z" }),
  JSON.stringify({ level: "debug", message: "verbose trace", time: "2026-03-13T00:02:00Z" }),
  JSON.stringify({ level: "warn", message: "disk almost full", time: "2026-03-13T00:03:00Z" }),
  JSON.stringify({ level: "info", message: "request handled", time: "2026-03-13T00:04:00Z" }),
];

describe("HTTP API logs endpoint", () => {
  beforeEach(() => {
    mkdirSync(logDir, { recursive: true });
    writeFileSync(logFile, LOG_LINES.join("\n") + "\n");
  });

  afterAll(() => {
    rmSync(logDir, { recursive: true, force: true });
  });

  it("GET /api/logs/tail returns log lines", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.lines).toBeInstanceOf(Array);
    expect(body.lines.length).toBe(5);
    expect(body.cursor).toBeGreaterThan(0);
    expect(typeof body.size).toBe("number");
  });

  it("GET /api/logs/tail with limit=2 returns at most 2 lines", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail?limit=2");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines.length).toBe(2);
  });

  it("GET /api/logs/tail with level=error filters to errors only", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail?level=error");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines.length).toBe(1);
    expect(JSON.parse(body.lines[0]).message).toBe("connection failed");
  });

  it("GET /api/logs/tail with level=warn includes errors and warnings", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail?level=warn");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lines.length).toBe(2);
  });

  it("POST /api/logs/tail works with JSON body", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail", {
      method: "POST",
      body: JSON.stringify({ limit: 3 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.lines.length).toBe(3);
  });

  it("POST /api/logs/tail with cursor at end returns no new lines", async () => {
    const app = createGatewayApp(createCtx());
    const res1 = await app.request("/api/logs/tail", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const body1 = await res1.json();

    const res2 = await app.request("/api/logs/tail", {
      method: "POST",
      body: JSON.stringify({ cursor: body1.cursor }),
      headers: { "Content-Type": "application/json" },
    });
    const body2 = await res2.json();
    expect(body2.lines.length).toBe(0);
  });

  it("GET /api/logs/tail returns 400 for invalid limit", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail?limit=0");
    expect(res.status).toBe(400);
  });

  it("GET /api/logs/tail returns 400 for invalid level", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail?level=fatal");
    expect(res.status).toBe(400);
  });

  it("returns empty lines when log file does not exist", async () => {
    rmSync(logFile, { force: true });
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/logs/tail");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.lines).toEqual([]);
    expect(body.size).toBe(0);
  });
});
