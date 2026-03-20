import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs for session map persistence (must be before imports).
// Pass through reads for prompt template files so the template loader works.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: vi.fn((path: string, ...args: unknown[]) => {
      if (typeof path === "string" && path.includes("/prompts/")) {
        return actual.readFileSync(path, ...args as [BufferEncoding]);
      }
      throw new Error("ENOENT");
    }),
    statSync: vi.fn((path: string, ...args: unknown[]) => {
      if (typeof path === "string" && path.includes("/prompts/")) {
        return actual.statSync(path, ...args as []);
      }
      throw new Error("ENOENT");
    }),
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

  it("skill trigger routes to engine with skill reference as prompt", async () => {
    const skills = [
      {
        name: "standup",
        description: "Daily standup",
        triggers: ["/standup"],
        body: "Review my recent git commits.",
        path: "/skills/standup/SKILL.md",
        invocation: { userInvocable: true, disableModelInvocation: false },
      },
    ];
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"], skills });
    const result = await router(makeMessage({ text: "/standup" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    // Prompt references skill name (body injected via system prompt skills section)
    expect(submitArg.prompt).toContain("standup");
    expect(result).toBe("engine response");
  });

  it("skill trigger with args includes user input in prompt", async () => {
    const skills = [
      {
        name: "standup",
        description: "Daily standup",
        triggers: ["/standup"],
        body: "Review my recent git commits.",
        path: "/skills/standup/SKILL.md",
        invocation: { userInvocable: true, disableModelInvocation: false },
      },
    ];
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"], skills });
    await router(makeMessage({ text: "/standup for last week" }));

    const submitArg = pool.submit.mock.calls[0][0];
    expect(submitArg.prompt).toContain("standup");
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
    expect(submitArg.systemPrompt).toContain("Memory Context (auto-loaded)");
    expect(submitArg.systemPrompt).toContain("Sean is a software engineer");
    expect(submitArg.systemPrompt).toContain("sean.md#L1-L3");
    expect(submitArg.systemPrompt).toContain("0.95");
  });

  it("first message always gets systemPrompt even without memory results", async () => {
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
    // System prompt is always generated on first message (OpenClaw parity)
    expect(submitArg.systemPrompt).toBeDefined();
    expect(submitArg.systemPrompt).toContain("OpenClaude");
    // No memory context section when no results
    expect(submitArg.systemPrompt).not.toContain("Memory Context (auto-loaded)");
  });

  it("first message always gets systemPrompt even without memoryManager", async () => {
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });
    await router(makeMessage({ text: "hello there" }));

    expect(pool.submit).toHaveBeenCalledOnce();
    const submitArg = pool.submit.mock.calls[0][0];
    // System prompt always present on first message
    expect(submitArg.systemPrompt).toBeDefined();
    expect(submitArg.systemPrompt).toContain("OpenClaude");
  });

  it("continues with systemPrompt (no memory section) when memory search throws", async () => {
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
    // System prompt still generated, just without memory context
    expect(submitArg.systemPrompt).toBeDefined();
    expect(submitArg.systemPrompt).toContain("OpenClaude");
    expect(submitArg.systemPrompt).not.toContain("Memory Context (auto-loaded)");
  });

  it("accumulates token usage across turns in session", async () => {
    pool.submit
      .mockResolvedValueOnce({
        text: "first",
        usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.01 },
      })
      .mockResolvedValueOnce({
        text: "second",
        usage: { inputTokens: 1500, outputTokens: 300, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.02 },
      });
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });

    await router(makeMessage({ chatId: "70", text: "first" }));
    await router(makeMessage({ chatId: "70", text: "second" }));

    // Verify sessions-map was saved with accumulated usage
    const { writeFileSync: mockWrite } = await import("node:fs");
    const calls = vi.mocked(mockWrite).mock.calls;
    // Find last sessions-map write
    const lastWrite = calls.filter(c => String(c[0]).includes("sessions-map")).pop();
    expect(lastWrite).toBeDefined();
    const savedData = JSON.parse(lastWrite![1] as string);
    const session = Object.values(savedData)[0] as Record<string, unknown>;
    expect(session.totalInputTokens).toBe(2500);
    expect(session.totalOutputTokens).toBe(500);
    expect(session.totalCostUsd).toBe(0.03);
  });

  it("tracks compaction count when compacted flag is set", async () => {
    pool.submit
      .mockResolvedValueOnce({ text: "first" })
      .mockResolvedValueOnce({ text: "second", compacted: true, preCompactTokens: 180000 });
    const router = createRouter({ pool: pool as unknown as Parameters<typeof createRouter>[0]["pool"] });

    await router(makeMessage({ chatId: "71", text: "first" }));
    await router(makeMessage({ chatId: "71", text: "second" }));

    const { writeFileSync: mockWrite } = await import("node:fs");
    const calls = vi.mocked(mockWrite).mock.calls;
    const lastWrite = calls.filter(c => String(c[0]).includes("sessions-map")).pop();
    const savedData = JSON.parse(lastWrite![1] as string);
    const session = Object.values(savedData)[0] as Record<string, unknown>;
    expect(session.compactionCount).toBe(1);
    expect(session.lastCompactedAt).toBeDefined();
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
