/**
 * Contract tests for end-to-end message flows.
 *
 * Tests that messages flow correctly through the router and engine.
 * Uses the real createRouter from router/router.ts with a mocked pool.
 * Channels are not involved — we simulate inbound messages directly.
 *
 * Dependencies:
 * - router/router.ts         → real createRouter (under test)
 * - router/commands.ts        → real createCommandHandlers (under test)
 * - engine/pool.js           → mocked ProcessPool (submit, stats, etc.)
 *
 * Contracts verified:
 * 1. Telegram text → router → engine → response text returned
 * 2. /help command → router → direct response (no engine call)
 * 3. Cron trigger → isolated session → response with cron- prefixed sessionId
 * 4. Same chat reuses session ID across multiple messages
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createRouter } from "../router/router.js";
import type { InboundMessage } from "../channels/types.js";

// --- Mock pool ---

function createMockPool(responseText = "Hello from Claude") {
  const submitCalls: Array<{
    sessionId: string;
    prompt: string;
    timeout?: number;
  }> = [];

  const pool = {
    submit: vi.fn().mockImplementation(async (task: {
      sessionId: string;
      prompt: string;
      timeout?: number;
    }) => {
      submitCalls.push(task);
      return { text: responseText, exitCode: 0, duration: 100 };
    }),
    stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
    listSessions: vi.fn().mockReturnValue([]),
    killSession: vi.fn().mockReturnValue(false),
    getSession: vi.fn().mockReturnValue(undefined),
    drain: vi.fn().mockResolvedValue(undefined),
  };

  return { pool, submitCalls };
}

function makeMessage(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channel: "telegram",
    chatId: "chat-123",
    userId: "user-456",
    username: "testuser",
    text: "Hello, Claude!",
    source: "user",
    ...overrides,
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("telegram text → router → engine → response", () => {
  it("routes user text through pool.submit and returns response", async () => {
    const { pool, submitCalls } = createMockPool("I am Claude. How can I help?");
    const router = createRouter({ pool });

    const message = makeMessage({ text: "What is the weather today?" });
    const response = await router(message);

    // Pool was called
    expect(pool.submit).toHaveBeenCalledTimes(1);

    // Correct prompt forwarded
    expect(submitCalls[0].prompt).toBe("What is the weather today?");

    // Session ID starts with "main-" for user messages
    expect(submitCalls[0].sessionId).toMatch(/^main-/);

    // Response text returned
    expect(response).toBe("I am Claude. How can I help?");
  });

  it("returns error message when pool.submit rejects", async () => {
    const { pool } = createMockPool();
    pool.submit.mockRejectedValueOnce(new Error("Process timed out"));

    const router = createRouter({ pool });
    const message = makeMessage({ text: "slow question" });

    const response = await router(message);

    expect(response).toContain("Error:");
    expect(response).toContain("Process timed out");
  });
});

describe("/command → router → direct response (no engine)", () => {
  it("/help returns help text without calling pool.submit", async () => {
    const { pool } = createMockPool();
    const router = createRouter({ pool });

    const message = makeMessage({ text: "/help" });
    const response = await router(message);

    // Pool should NOT be called for commands
    expect(pool.submit).not.toHaveBeenCalled();

    // Response should contain help information
    expect(response).toContain("OpenClaude Commands:");
    expect(response).toContain("/help");
    expect(response).toContain("/status");
    expect(response).toContain("/list");
  });

  it("/status returns system status without calling pool.submit", async () => {
    const { pool } = createMockPool();
    pool.stats.mockReturnValue({ running: 2, queued: 1, maxConcurrent: 4 });

    const router = createRouter({ pool });
    const message = makeMessage({ text: "/status" });
    const response = await router(message);

    expect(pool.submit).not.toHaveBeenCalled();
    expect(response).toContain("Running: 2/4");
    expect(response).toContain("Queued: 1");
  });

  it("/list shows no active sessions", async () => {
    const { pool } = createMockPool();
    const router = createRouter({ pool });

    const message = makeMessage({ text: "/list" });
    const response = await router(message);

    expect(pool.submit).not.toHaveBeenCalled();
    expect(response).toContain("No active sessions");
  });

  it("/help@botname format is handled correctly", async () => {
    const { pool } = createMockPool();
    const router = createRouter({ pool });

    const message = makeMessage({ text: "/help@MyOpenClaudeBot" });
    const response = await router(message);

    expect(pool.submit).not.toHaveBeenCalled();
    expect(response).toContain("OpenClaude Commands:");
  });
});

describe("cron trigger → isolated session", () => {
  it("cron message uses session ID starting with cron-", async () => {
    const { pool, submitCalls } = createMockPool("Cron task completed");
    const router = createRouter({ pool });

    const message = makeMessage({
      text: "Run daily health check",
      source: "cron",
      channel: "system",
      chatId: "cron-daily",
    });

    const response = await router(message);

    expect(pool.submit).toHaveBeenCalledTimes(1);
    expect(submitCalls[0].sessionId).toMatch(/^cron-/);
    expect(submitCalls[0].prompt).toBe("Run daily health check");
    expect(response).toBe("Cron task completed");
  });

  it("cron message includes timeout", async () => {
    const { pool, submitCalls } = createMockPool("Done");
    const router = createRouter({ pool });

    const message = makeMessage({
      text: "Run task",
      source: "cron",
      channel: "system",
      chatId: "cron-task",
    });

    await router(message);

    expect(submitCalls[0].timeout).toBe(300_000);
  });

  it("each cron invocation gets a unique session ID", async () => {
    const { pool, submitCalls } = createMockPool("ok");
    const router = createRouter({ pool });

    const msg1 = makeMessage({ text: "task 1", source: "cron", chatId: "cron-1" });
    const msg2 = makeMessage({ text: "task 2", source: "cron", chatId: "cron-1" });

    await router(msg1);
    await router(msg2);

    expect(submitCalls[0].sessionId).toMatch(/^cron-/);
    expect(submitCalls[1].sessionId).toMatch(/^cron-/);
    // Each cron run should get a different isolated session
    expect(submitCalls[0].sessionId).not.toBe(submitCalls[1].sessionId);
  });
});

describe("session ID reuse for same chat", () => {
  it("same channel + chatId reuses session ID across messages", async () => {
    const { pool, submitCalls } = createMockPool("reply");
    const router = createRouter({ pool });

    const msg1 = makeMessage({
      channel: "telegram",
      chatId: "chat-999",
      text: "first message",
    });
    const msg2 = makeMessage({
      channel: "telegram",
      chatId: "chat-999",
      text: "second message",
    });

    await router(msg1);
    await router(msg2);

    expect(pool.submit).toHaveBeenCalledTimes(2);
    expect(submitCalls[0].sessionId).toBe(submitCalls[1].sessionId);
    expect(submitCalls[0].sessionId).toMatch(/^main-/);
  });

  it("different chatId gets different session ID", async () => {
    const { pool, submitCalls } = createMockPool("reply");
    const router = createRouter({ pool });

    const msg1 = makeMessage({
      channel: "telegram",
      chatId: "chat-aaa",
      text: "hello",
    });
    const msg2 = makeMessage({
      channel: "telegram",
      chatId: "chat-bbb",
      text: "hello",
    });

    await router(msg1);
    await router(msg2);

    expect(submitCalls[0].sessionId).not.toBe(submitCalls[1].sessionId);
  });

  it("same chatId on different channels gets different session ID", async () => {
    const { pool, submitCalls } = createMockPool("reply");
    const router = createRouter({ pool });

    const msg1 = makeMessage({
      channel: "telegram",
      chatId: "chat-123",
      text: "hello",
    });
    const msg2 = makeMessage({
      channel: "slack",
      chatId: "chat-123",
      text: "hello",
    });

    await router(msg1);
    await router(msg2);

    expect(submitCalls[0].sessionId).not.toBe(submitCalls[1].sessionId);
  });
});
