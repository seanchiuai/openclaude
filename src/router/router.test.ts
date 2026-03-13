import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCommand, deriveSessionKey, createRouter } from "./router.js";
import type { InboundMessage } from "../channels/types.js";

// --- parseCommand tests (existing, preserved) ---

describe("parseCommand", () => {
  it("parses simple command", () => {
    expect(parseCommand("/list")).toEqual({ name: "list", args: "" });
  });

  it("parses command with args", () => {
    expect(parseCommand("/stop session-123")).toEqual({
      name: "stop",
      args: "session-123",
    });
  });

  it("strips @botname", () => {
    expect(parseCommand("/list@mybot")).toEqual({ name: "list", args: "" });
  });

  it("handles command with @botname and args", () => {
    expect(parseCommand("/stop@mybot abc")).toEqual({
      name: "stop",
      args: "abc",
    });
  });

  it("lowercases command name", () => {
    expect(parseCommand("/STATUS")).toEqual({ name: "status", args: "" });
  });
});

// --- deriveSessionKey tests (existing, preserved) ---

describe("deriveSessionKey", () => {
  it("combines channel and chatId", () => {
    const msg: InboundMessage = {
      channel: "telegram",
      chatId: "123",
      userId: "456",
      text: "hello",
      source: "user",
    };
    expect(deriveSessionKey(msg)).toBe("telegram:123");
  });
});

// --- createRouter integration tests ---

function createMockPool() {
  return {
    submit: vi.fn().mockResolvedValue({ text: "engine response" }),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    killSession: vi.fn(),
    drain: vi.fn(),
    stats: vi.fn().mockReturnValue({ running: 0, maxConcurrent: 4, queued: 0 }),
  };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "telegram",
    chatId: "100",
    userId: "200",
    text: "hello",
    source: "user",
    ...overrides,
  };
}

describe("createRouter", () => {
  let pool: ReturnType<typeof createMockPool>;

  beforeEach(() => {
    pool = createMockPool();
  });

  it("/help routes to command handler, returns help text (not engine)", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "/help" }));

    expect(result).toContain("OpenClaude Commands:");
    expect(pool.submit).not.toHaveBeenCalled();
  });

  it("/list routes to command handler", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "/list" }));

    expect(result).toContain("No active sessions");
    expect(pool.submit).not.toHaveBeenCalled();
  });

  it("/command@botname strips bot mention", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "/help@mybot" }));

    expect(result).toContain("OpenClaude Commands:");
    expect(pool.submit).not.toHaveBeenCalled();
  });

  it("unknown /command falls through to engine (pool.submit called)", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ text: "/unknown do stuff" }));

    expect(pool.submit).toHaveBeenCalled();
  });

  it("user message routes to engine with session ID", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "build a website" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.sessionId).toMatch(/^main-/);
    expect(submitArg.prompt).toBe("build a website");
    expect(result).toBe("engine response");
  });

  it("same chat reuses session key (pool.submit called with same sessionId both times)", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });

    await router(makeMessage({ chatId: "42", text: "first" }));
    await router(makeMessage({ chatId: "42", text: "second" }));

    expect(pool.submit).toHaveBeenCalledTimes(2);
    const firstSessionId = pool.submit.mock.calls[0][0].sessionId;
    const secondSessionId = pool.submit.mock.calls[1][0].sessionId;
    expect(firstSessionId).toBe(secondSessionId);
  });

  it("different chats get different session keys", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });

    await router(makeMessage({ chatId: "1", text: "hi" }));
    await router(makeMessage({ chatId: "2", text: "hi" }));

    expect(pool.submit).toHaveBeenCalledTimes(2);
    const firstSessionId = pool.submit.mock.calls[0][0].sessionId;
    const secondSessionId = pool.submit.mock.calls[1][0].sessionId;
    expect(firstSessionId).not.toBe(secondSessionId);
  });

  it("cron source gets isolated session ID with cron- prefix", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ source: "cron", text: "run backup" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.sessionId).toMatch(/^cron-/);
    expect(submitArg.prompt).toBe("run backup");
  });

  it("engine error returns error message to channel", async () => {
    pool.submit.mockRejectedValueOnce(new Error("subprocess crashed"));
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "do something" }));

    expect(result).toBe("Error: subprocess crashed");
  });
});
