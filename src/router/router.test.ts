import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs for session map persistence (must be before imports)
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
    writeFileSync: vi.fn(),
  };
});

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

  it("skill trigger routes to engine with skill body as prompt", async () => {
    const skills = [
      {
        name: "daily-standup",
        description: "Daily standup",
        triggers: ["/standup"],
        body: "Review my recent git commits.",
        path: "/skills/standup/SKILL.md",
      },
    ];
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"], skills });
    const result = await router(makeMessage({ text: "/standup" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.prompt).toBe("Review my recent git commits.");
    expect(result).toBe("engine response");
  });

  it("skill trigger with args appends user request", async () => {
    const skills = [
      {
        name: "daily-standup",
        description: "Daily standup",
        triggers: ["/standup"],
        body: "Review my recent git commits.",
        path: "/skills/standup/SKILL.md",
      },
    ];
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"], skills });
    await router(makeMessage({ text: "/standup for last week" }));

    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.prompt).toContain("Review my recent git commits.");
    expect(submitArg.prompt).toContain("for last week");
  });

  it("injects memory context into systemPrompt for user messages", async () => {
    const mockMemoryManager = {
      search: vi.fn().mockResolvedValue([
        {
          path: "/memory/sean.md",
          snippet: "Sean is a software engineer who loves TypeScript.",
          score: 0.95,
          citation: "sean.md#L1-L3",
        },
        {
          path: "/memory/sean.md",
          snippet: "Sean's favorite color is blue.",
          score: 0.82,
          citation: "sean.md#L5-L6",
        },
      ]),
      status: vi.fn(),
      sync: vi.fn(),
      ingest: vi.fn(),
      close: vi.fn(),
    };

    const router = createRouter({
      pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"],
      memoryManager: mockMemoryManager as unknown as Parameters<typeof createRouter>[0]["memoryManager"],
    });

    await router(makeMessage({ text: "what do you know about Sean?" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.systemPrompt).toBeDefined();
    expect(submitArg.systemPrompt).toContain("persistent memory system");
    expect(submitArg.systemPrompt).toContain("Sean is a software engineer");
    expect(submitArg.systemPrompt).toContain("sean.md#L1-L3");
    expect(submitArg.systemPrompt).toContain("0.95");
  });

  it("does not inject systemPrompt when memoryManager returns no results", async () => {
    const mockMemoryManager = {
      search: vi.fn().mockResolvedValue([]),
      status: vi.fn(),
      sync: vi.fn(),
      ingest: vi.fn(),
      close: vi.fn(),
    };

    const router = createRouter({
      pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"],
      memoryManager: mockMemoryManager as unknown as Parameters<typeof createRouter>[0]["memoryManager"],
    });

    await router(makeMessage({ text: "hello there" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.systemPrompt).toBeUndefined();
  });

  it("does not inject systemPrompt when memoryManager is not provided", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ text: "hello there" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.systemPrompt).toBeUndefined();
  });

  it("continues without systemPrompt when memory search throws", async () => {
    const mockMemoryManager = {
      search: vi.fn().mockRejectedValue(new Error("DB connection failed")),
      status: vi.fn(),
      sync: vi.fn(),
      ingest: vi.fn(),
      close: vi.fn(),
    };

    const router = createRouter({
      pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"],
      memoryManager: mockMemoryManager as unknown as Parameters<typeof createRouter>[0]["memoryManager"],
    });

    await router(makeMessage({ text: "what do you know about Sean?" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.systemPrompt).toBeUndefined();
  });

  it("engine error returns error message to channel", async () => {
    pool.submit.mockRejectedValueOnce(new Error("subprocess crashed"));
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    const result = await router(makeMessage({ text: "do something" }));

    expect(result).toBe("Error: subprocess crashed");
  });

  it("first message passes claudeSessionId with --session-id (resumeSession false)", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ chatId: "50", text: "first message" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.claudeSessionId).toBeDefined();
    expect(submitArg.resumeSession).toBe(false);
  });

  it("second message in same chat passes resumeSession true", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ chatId: "51", text: "first" }));
    await router(makeMessage({ chatId: "51", text: "second" }));

    expect(pool.submit).toHaveBeenCalledTimes(2);
    const first = pool.submit.mock.calls[0][0];
    const second = pool.submit.mock.calls[1][0];

    // Same Claude session UUID
    expect(first.claudeSessionId).toBe(second.claudeSessionId);
    // First is not resume, second is resume
    expect(first.resumeSession).toBe(false);
    expect(second.resumeSession).toBe(true);
  });

  it("second message skips systemPrompt (context already in session)", async () => {
    const mockMemoryManager = {
      search: vi.fn().mockResolvedValue([
        { path: "/memory/test.md", snippet: "test memory", score: 0.9, citation: "test.md#L1" },
      ]),
      status: vi.fn(),
      sync: vi.fn(),
      ingest: vi.fn(),
      close: vi.fn(),
    };

    const router = createRouter({
      pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"],
      memoryManager: mockMemoryManager as unknown as Parameters<typeof createRouter>[0]["memoryManager"],
    });

    await router(makeMessage({ chatId: "52", text: "first" }));
    await router(makeMessage({ chatId: "52", text: "second" }));

    const first = pool.submit.mock.calls[0][0];
    const second = pool.submit.mock.calls[1][0];

    expect(first.systemPrompt).toBeDefined();
    expect(second.systemPrompt).toBeUndefined();
  });

  it("/reset clears session so next message starts fresh", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });

    // Send first message to create session
    await router(makeMessage({ chatId: "53", text: "hello" }));
    const firstClaudeSessionId = pool.submit.mock.calls[0][0].claudeSessionId;

    // Reset
    const resetResult = await router(makeMessage({ chatId: "53", text: "/reset" }));
    expect(resetResult).toContain("Session reset");

    // Send another message — should get a new session
    await router(makeMessage({ chatId: "53", text: "hello again" }));
    const secondClaudeSessionId = pool.submit.mock.calls[1][0].claudeSessionId;

    expect(secondClaudeSessionId).not.toBe(firstClaudeSessionId);
    expect(pool.submit.mock.calls[1][0].resumeSession).toBe(false);
  });
});
