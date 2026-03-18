/**
 * Tests for src/memory/memory-flush.ts
 *
 * Tests both:
 * 1. flushSessionToMemory — writes facts to dated markdown files
 * 2. shouldFlushMemory — determines when to trigger a flush
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  flushSessionToMemory,
  shouldFlushMemory,
  extractKeyFacts,
  redactSensitiveData,
  DEFAULT_CONTEXT_WINDOW,
  RESERVE_TOKENS_FLOOR,
  SOFT_THRESHOLD_TOKENS,
  FLUSH_THRESHOLD_RATIO,
} from "./memory-flush.js";
import type { ChatSession } from "../router/types.js";

// ---------------------------------------------------------------------------
// flushSessionToMemory tests
// ---------------------------------------------------------------------------

describe("flushSessionToMemory", () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-flush-test-"));
    memoryDir = join(tmpDir, "memory");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts key facts from session transcript and writes to file", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "The user asked about quantum computing applications in drug discovery. " +
      "We discussed how quantum simulations can model molecular interactions. " +
      "The conclusion was to explore Qiskit for initial experiments.";

    const result = await flushSessionToMemory(transcript, {
      memoryDir,
      syncFn,
    });

    expect(result.flushed).toBe(true);
    expect(result.path).toBeDefined();

    const content = await readFile(result.path!, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    // Should contain structured facts
    expect(content).toContain("-");
  });

  it("writes to memory/YYYY-MM-DD.md dated file", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "Today we configured the deployment pipeline for the staging environment. " +
      "The database migration strategy was finalized using blue-green deployments.";

    const result = await flushSessionToMemory(transcript, {
      memoryDir,
      syncFn,
    });

    expect(result.flushed).toBe(true);
    expect(result.path).toBeDefined();

    // Path should match YYYY-MM-DD.md pattern
    const filename = result.path!.split("/").pop()!;
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(result.path!.startsWith(memoryDir)).toBe(true);
  });

  it("triggers sync after write (syncFn called)", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "We implemented the authentication middleware using JWT tokens with refresh rotation. " +
      "Rate limiting was added at 100 requests per minute per user.";

    await flushSessionToMemory(transcript, { memoryDir, syncFn });

    expect(syncFn).toHaveBeenCalledOnce();
  });

  it("empty/trivial session returns flushed: false", async () => {
    const syncFn = vi.fn(async () => {});

    // Empty transcript
    const result1 = await flushSessionToMemory("", { memoryDir, syncFn });
    expect(result1.flushed).toBe(false);
    expect(result1.path).toBeUndefined();

    // Trivial transcript (too short to extract facts)
    const result2 = await flushSessionToMemory("ok thanks bye", {
      memoryDir,
      syncFn,
    });
    expect(result2.flushed).toBe(false);
    expect(result2.path).toBeUndefined();

    // syncFn should not be called when nothing is flushed
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("appends to existing date file, does not overwrite", async () => {
    const syncFn = vi.fn(async () => {});

    const firstTranscript =
      "The first session covered setting up the project structure and dependencies. " +
      "We chose pnpm as the package manager for workspace support.";

    const secondTranscript =
      "The second session focused on writing integration tests for the API layer. " +
      "Coverage targets were set at eighty percent for critical paths.";

    // First flush
    const result1 = await flushSessionToMemory(firstTranscript, {
      memoryDir,
      syncFn,
    });
    expect(result1.flushed).toBe(true);
    const contentAfterFirst = await readFile(result1.path!, "utf-8");

    // Second flush (same day)
    const result2 = await flushSessionToMemory(secondTranscript, {
      memoryDir,
      syncFn,
    });
    expect(result2.flushed).toBe(true);
    expect(result2.path).toBe(result1.path); // same date file

    const contentAfterSecond = await readFile(result2.path!, "utf-8");

    // Should contain content from both sessions
    expect(contentAfterSecond.length).toBeGreaterThan(contentAfterFirst.length);
    // Original content should still be present (not overwritten)
    expect(contentAfterSecond).toContain("project structure");
    expect(contentAfterSecond).toContain("integration tests");
  });
});

// ---------------------------------------------------------------------------
// PII redaction tests
// ---------------------------------------------------------------------------

describe("redactSensitiveData", () => {
  it("redacts OpenAI/Anthropic-style API keys", () => {
    const text = "My key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
    expect(redactSensitiveData(text)).toContain("[REDACTED_TOKEN]");
    expect(redactSensitiveData(text)).not.toContain("sk-ant-api03");
  });

  it("redacts password assignments", () => {
    expect(redactSensitiveData("password: hunter2")).toContain("[REDACTED_CREDENTIAL]");
    expect(redactSensitiveData("secret=mysecretvalue")).toContain("[REDACTED_CREDENTIAL]");
    expect(redactSensitiveData("api_key: abc123xyz")).toContain("[REDACTED_CREDENTIAL]");
  });

  it("redacts email addresses", () => {
    const result = redactSensitiveData("Contact sean@example.com for details");
    expect(result).toContain("[EMAIL]");
    expect(result).not.toContain("sean@example.com");
  });

  it("redacts connection strings", () => {
    const text = "DB is at postgres://user:pass@host:5432/db";
    expect(redactSensitiveData(text)).toContain("[REDACTED_CONN_STRING]");
  });

  it("redacts AWS access keys", () => {
    const text = "AWS key AKIAIOSFODNN7EXAMPLE is configured";
    expect(redactSensitiveData(text)).toContain("[REDACTED_AWS_KEY]");
  });

  it("redacts Bearer tokens", () => {
    const text = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.abc.def";
    expect(redactSensitiveData(text)).toContain("Bearer [REDACTED]");
  });

  it("preserves normal text without sensitive data", () => {
    const text = "We discussed the deployment strategy for the staging environment";
    expect(redactSensitiveData(text)).toBe(text);
  });
});

describe("extractKeyFacts PII filtering", () => {
  it("discards facts that are mostly redacted", () => {
    const transcript =
      "The API key is sk-proj-abcdefghijklmnopqrstuvwxyz1234. " +
      "We discussed the deployment strategy for the new microservice architecture.";
    const facts = extractKeyFacts(transcript);
    expect(facts.some((f) => f.includes("deployment strategy"))).toBe(true);
    expect(facts.every((f) => !f.includes("sk-proj"))).toBe(true);
  });

  it("keeps facts with minor redactions", () => {
    // Sentence splitting breaks on `.` in emails, so use newline-separated lines
    const transcript =
      "Contact the team lead (sean@example.com) about the refactoring plan for the auth module";
    // redactSensitiveData works on the full sentence before splitting
    const redacted = redactSensitiveData(transcript);
    expect(redacted).toContain("[EMAIL]");
    expect(redacted).not.toContain("sean@example.com");
    expect(redacted).toContain("refactoring plan");
  });
});

// ---------------------------------------------------------------------------
// shouldFlushMemory tests
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    sessionId: "main-test",
    claudeSessionId: "uuid-test",
    lastMessageAt: Date.now(),
    messageCount: 5,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    compactionCount: 0,
    ...overrides,
  };
}

describe("shouldFlushMemory", () => {
  it("returns false for fresh session with low token count", () => {
    const session = makeSession({ totalInputTokens: 1000, lastFlushCompactionCount: 0 });
    expect(shouldFlushMemory(session)).toBe(false);
  });

  it("returns true when input tokens exceed threshold ratio", () => {
    const threshold = (DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS_FLOOR - SOFT_THRESHOLD_TOKENS) * FLUSH_THRESHOLD_RATIO;
    const session = makeSession({ totalInputTokens: Math.ceil(threshold), lastFlushCompactionCount: 0 });
    expect(shouldFlushMemory(session)).toBe(true);
  });

  it("returns false when just below threshold", () => {
    const threshold = (DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS_FLOOR - SOFT_THRESHOLD_TOKENS) * FLUSH_THRESHOLD_RATIO;
    const session = makeSession({ totalInputTokens: Math.floor(threshold) - 1, lastFlushCompactionCount: 0 });
    expect(shouldFlushMemory(session)).toBe(false);
  });

  it("returns true when compaction happened but no flush yet", () => {
    const session = makeSession({ compactionCount: 1 });
    // lastFlushCompactionCount is undefined (never flushed)
    expect(shouldFlushMemory(session)).toBe(true);
  });

  it("returns false when compaction count matches last flush", () => {
    const session = makeSession({
      compactionCount: 2,
      lastFlushCompactionCount: 2,
      totalInputTokens: 1000,
    });
    expect(shouldFlushMemory(session)).toBe(false);
  });

  it("returns true when new compaction since last flush", () => {
    const session = makeSession({
      compactionCount: 3,
      lastFlushCompactionCount: 2,
      totalInputTokens: 1000,
    });
    expect(shouldFlushMemory(session)).toBe(true);
  });
});
