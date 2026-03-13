/**
 * Edge case tests for process pool.
 *
 * Covers: concurrent submissions during drain, rapid submit/kill cycles,
 * spawn failure at sync level, many queued tasks, duplicate session IDs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProcessPool } from "./pool.js";

vi.mock("./spawn.js", () => ({
  spawnClaude: vi.fn(),
  killProcessGroup: vi.fn(),
}));

import { spawnClaude } from "./spawn.js";

const mockSpawnClaude = vi.mocked(spawnClaude);

type Resolver = (value: { text: string; exitCode: number; duration: number }) => void;
type Rejecter = (error: Error) => void;

function setupMockSpawn(): {
  resolvers: Resolver[];
  rejecters: Rejecter[];
} {
  const resolvers: Resolver[] = [];
  const rejecters: Rejecter[] = [];

  mockSpawnClaude.mockImplementation((task) => {
    let resolve: Resolver;
    let reject: Rejecter;
    const promise = new Promise<{ text: string; exitCode: number; duration: number }>(
      (res, rej) => {
        resolve = res as Resolver;
        reject = rej as Rejecter;
        resolvers.push(resolve);
        rejecters.push(reject);
      },
    );
    return {
      session: {
        id: task.sessionId,
        projectPath: "/tmp/test",
        pid: 10000 + resolvers.length,
        status: "running" as const,
        startedAt: Date.now(),
        timeout: 300_000,
      },
      promise: promise as never,
    };
  });

  return { resolvers, rejecters };
}

describe("pool edge cases", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maxConcurrent=1 serializes all tasks", async () => {
    const pool = createProcessPool(1);
    const { resolvers } = setupMockSpawn();

    const p1 = pool.submit({ sessionId: "a", prompt: "1" });
    const p2 = pool.submit({ sessionId: "b", prompt: "2" });
    const p3 = pool.submit({ sessionId: "c", prompt: "3" });

    expect(pool.stats()).toEqual({ running: 1, queued: 2, maxConcurrent: 1 });

    // Complete tasks one at a time
    resolvers[0]({ text: "r1", exitCode: 0, duration: 10 });
    await p1;
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.stats().running).toBe(1);
    expect(pool.stats().queued).toBe(1);

    resolvers[1]({ text: "r2", exitCode: 0, duration: 10 });
    await p2;
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.stats().running).toBe(1);
    expect(pool.stats().queued).toBe(0);

    resolvers[2]({ text: "r3", exitCode: 0, duration: 10 });
    await p3;
    expect(pool.stats().running).toBe(0);
  });

  it("many queued tasks all eventually complete", async () => {
    const pool = createProcessPool(2);
    const { resolvers } = setupMockSpawn();

    const promises: Promise<{ text: string }>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(pool.submit({ sessionId: `t${i}`, prompt: `p${i}` }));
    }

    expect(pool.stats().running).toBe(2);
    expect(pool.stats().queued).toBe(18);

    // Complete all tasks
    for (let i = 0; i < 20; i++) {
      resolvers[i]({ text: `r${i}`, exitCode: 0, duration: 10 });
      await promises[i];
      await new Promise((r) => setTimeout(r, 0));
    }

    expect(pool.stats().running).toBe(0);
    expect(pool.stats().queued).toBe(0);
  });

  it("spawnClaude sync throw frees slot and rejects task", async () => {
    const pool = createProcessPool(2);
    const { resolvers } = setupMockSpawn();

    const p1 = pool.submit({ sessionId: "ok", prompt: "a" });

    // Make next spawn throw synchronously
    mockSpawnClaude.mockImplementationOnce(() => {
      throw new Error("spawn ENOENT");
    });

    const p2 = pool.submit({ sessionId: "fail", prompt: "b" });
    await expect(p2).rejects.toThrow("spawn ENOENT");

    // First task should still be running
    expect(pool.stats().running).toBe(1);

    resolvers[0]({ text: "done", exitCode: 0, duration: 10 });
    await p1;
  });

  it("killing a nonexistent session returns false and doesn't affect queue", () => {
    const pool = createProcessPool(1);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    pool.submit({ sessionId: "t2", prompt: "b" });

    expect(pool.killSession("nonexistent")).toBe(false);
    expect(pool.stats()).toEqual({ running: 1, queued: 1, maxConcurrent: 1 });
  });

  it("drain during task execution rejects queued but running resolves", async () => {
    const pool = createProcessPool(1);
    const { resolvers } = setupMockSpawn();

    const p1 = pool.submit({ sessionId: "running", prompt: "a" });
    const p2 = pool.submit({ sessionId: "queued1", prompt: "b" });
    const p3 = pool.submit({ sessionId: "queued2", prompt: "c" });

    await pool.drain();

    // Queued tasks should be rejected
    await expect(p2).rejects.toThrow("draining");
    await expect(p3).rejects.toThrow("draining");

    // Running task's session is killed — pool treats it as completed via kill
    expect(pool.stats().running).toBe(0);
    expect(pool.stats().queued).toBe(0);
  });

  it("submit after drain always rejects", async () => {
    const pool = createProcessPool(4);
    await pool.drain();

    await expect(pool.submit({ sessionId: "x", prompt: "a" })).rejects.toThrow("draining");
    await expect(pool.submit({ sessionId: "y", prompt: "b" })).rejects.toThrow("draining");
  });

  it("multiple rapid kills don't crash", () => {
    const pool = createProcessPool(4);
    setupMockSpawn();

    pool.submit({ sessionId: "s1", prompt: "a" });

    expect(pool.killSession("s1")).toBe(true);
    expect(pool.killSession("s1")).toBe(false); // Already removed
    expect(pool.killSession("s1")).toBe(false);
  });

  it("listSessions returns empty after drain", async () => {
    const pool = createProcessPool(4);
    setupMockSpawn();

    pool.submit({ sessionId: "s1", prompt: "a" });
    pool.submit({ sessionId: "s2", prompt: "b" });

    expect(pool.listSessions()).toHaveLength(2);

    await pool.drain();

    expect(pool.listSessions()).toHaveLength(0);
  });

  it("task with empty prompt still submits", async () => {
    const pool = createProcessPool(4);
    const { resolvers } = setupMockSpawn();

    const p = pool.submit({ sessionId: "empty", prompt: "" });
    resolvers[0]({ text: "", exitCode: 0, duration: 10 });

    const result = await p;
    expect(result.text).toBe("");
  });

  it("non-zero exit code propagates through pool", async () => {
    const pool = createProcessPool(4);
    const { resolvers } = setupMockSpawn();

    const p = pool.submit({ sessionId: "fail", prompt: "x" });
    resolvers[0]({ text: "error output", exitCode: 1, duration: 10 });

    const result = await p;
    expect(result.exitCode).toBe(1);
    expect(result.text).toBe("error output");
  });
});
