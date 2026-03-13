/**
 * Edge case tests for gateway HTTP API endpoints.
 *
 * Covers: cron API validation, memory API bounds, send to unknown channel,
 * missing services (503), invalid JSON bodies, cross-field validation.
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

function createMockCronService() {
  return {
    list: vi.fn().mockReturnValue([]),
    add: vi.fn().mockReturnValue({ id: "job-1", name: "test" }),
    remove: vi.fn().mockReturnValue(true),
    run: vi.fn().mockResolvedValue({ status: "ok", summary: "done" }),
    status: vi.fn().mockReturnValue({ running: true, jobCount: 0, enabledCount: 0 }),
    getJob: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

function createMockMemoryManager() {
  return {
    search: vi.fn().mockResolvedValue([]),
    readFile: vi.fn().mockResolvedValue({ path: "test.md", text: "content" }),
    sync: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
  };
}

function createMockChannelAdapter() {
  return {
    id: "telegram",
    start: vi.fn(),
    stop: vi.fn(),
    sendText: vi.fn().mockResolvedValue({ messageId: 42, success: true }),
    sendMedia: vi.fn(),
  };
}

function createCtx(overrides?: Partial<GatewayContext>): GatewayContext {
  return {
    pool: createMockPool() as unknown as GatewayContext["pool"],
    startedAt: Date.now() - 5000,
    channels: ["telegram"],
    ...overrides,
  };
}

describe("HTTP API cron endpoints", () => {
  it("POST /api/cron/list returns 503 when cron service not available", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/cron/list", { method: "POST" });
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not available");
  });

  it("POST /api/cron/add returns 503 when cron service not available", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({ name: "test", schedule: { kind: "cron", expr: "* * * * *" }, prompt: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
  });

  it("POST /api/cron/add returns 400 for missing required fields", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({ name: "test" }), // missing schedule and prompt
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron/add returns 400 for invalid schedule kind", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({
        name: "test",
        schedule: { kind: "invalid" },
        prompt: "hello",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron/add accepts valid cron job", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({
        name: "test job",
        schedule: { kind: "cron", expr: "0 * * * *" },
        prompt: "check status",
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(cron.add).toHaveBeenCalled();
  });

  it("POST /api/cron/add accepts job with delivery target", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({
        name: "with target",
        schedule: { kind: "every", everyMs: 60000 },
        prompt: "reminder",
        target: { channel: "telegram", chatId: "12345" },
      }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
  });

  it("POST /api/cron/remove returns 400 for missing id", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/remove", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron/run returns 400 for missing id", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/run", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/cron/list returns jobs when service available", async () => {
    const cron = createMockCronService();
    cron.list.mockReturnValue([{ id: "j1", name: "job1" }]);
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/list", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.jobs).toHaveLength(1);
  });

  it("POST /api/cron/status returns service status", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/status", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.running).toBe(true);
  });
});

describe("HTTP API memory endpoints", () => {
  it("POST /api/memory/search returns 503 when memory not available", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/memory/search", {
      method: "POST",
      body: JSON.stringify({ query: "test" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
  });

  it("POST /api/memory/search returns 400 for missing query", async () => {
    const mem = createMockMemoryManager();
    const app = createGatewayApp(createCtx({ memoryManager: mem as never }));

    const res = await app.request("/api/memory/search", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/memory/search accepts optional params", async () => {
    const mem = createMockMemoryManager();
    const app = createGatewayApp(createCtx({ memoryManager: mem as never }));

    const res = await app.request("/api/memory/search", {
      method: "POST",
      body: JSON.stringify({ query: "test", maxResults: 5, minScore: 0.5 }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    expect(mem.search).toHaveBeenCalledWith("test", { maxResults: 5, minScore: 0.5 });
  });

  it("POST /api/memory/get returns 400 for missing path", async () => {
    const mem = createMockMemoryManager();
    const app = createGatewayApp(createCtx({ memoryManager: mem as never }));

    const res = await app.request("/api/memory/get", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/memory/get returns 400 when readFile throws", async () => {
    const mem = createMockMemoryManager();
    mem.readFile.mockRejectedValue(new Error("File not found"));
    const app = createGatewayApp(createCtx({ memoryManager: mem as never }));

    const res = await app.request("/api/memory/get", {
      method: "POST",
      body: JSON.stringify({ path: "nonexistent.md" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("File not found");
  });
});

describe("HTTP API send endpoint", () => {
  it("POST /api/send returns 503 when no channel adapters", async () => {
    const app = createGatewayApp(createCtx());
    const res = await app.request("/api/send", {
      method: "POST",
      body: JSON.stringify({ channel: "telegram", chatId: "123", text: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(503);
  });

  it("POST /api/send returns 404 for unknown channel", async () => {
    const adapters = new Map();
    adapters.set("telegram", createMockChannelAdapter());
    const app = createGatewayApp(createCtx({ channelAdapters: adapters }));

    const res = await app.request("/api/send", {
      method: "POST",
      body: JSON.stringify({ channel: "discord", chatId: "123", text: "hi" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/send returns 400 for missing required fields", async () => {
    const adapters = new Map();
    adapters.set("telegram", createMockChannelAdapter());
    const app = createGatewayApp(createCtx({ channelAdapters: adapters }));

    const res = await app.request("/api/send", {
      method: "POST",
      body: JSON.stringify({ channel: "telegram" }), // missing chatId and text
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("POST /api/send succeeds for valid request", async () => {
    const adapter = createMockChannelAdapter();
    const adapters = new Map();
    adapters.set("telegram", adapter);
    const app = createGatewayApp(createCtx({ channelAdapters: adapters }));

    const res = await app.request("/api/send", {
      method: "POST",
      body: JSON.stringify({ channel: "telegram", chatId: "123", text: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(adapter.sendText).toHaveBeenCalledWith("123", "hello");
  });

  it("POST /api/send returns 500 when adapter throws", async () => {
    const adapter = createMockChannelAdapter();
    adapter.sendText.mockRejectedValue(new Error("rate limited"));
    const adapters = new Map();
    adapters.set("telegram", adapter);
    const app = createGatewayApp(createCtx({ channelAdapters: adapters }));

    const res = await app.request("/api/send", {
      method: "POST",
      body: JSON.stringify({ channel: "telegram", chatId: "123", text: "hello" }),
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toContain("rate limited");
  });
});

describe("HTTP API invalid input handling", () => {
  it("returns 400 for non-JSON body on POST endpoint", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: "this is not json",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 for empty body on POST endpoint", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: "",
      headers: { "Content-Type": "application/json" },
    });
    expect(res.status).toBe(400);
  });

  it("strips unknown fields from request body", async () => {
    const cron = createMockCronService();
    const app = createGatewayApp(createCtx({ cronService: cron as never }));

    const res = await app.request("/api/cron/add", {
      method: "POST",
      body: JSON.stringify({
        name: "test",
        schedule: { kind: "cron", expr: "* * * * *" },
        prompt: "hello",
        malicious: "<script>alert(1)</script>",
      }),
      headers: { "Content-Type": "application/json" },
    });
    // Should succeed — unknown fields stripped by Zod
    expect(res.status).toBe(200);
  });
});
