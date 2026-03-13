/**
 * Contract: Process Pool for Claude Code CLI
 *
 * createProcessPool(maxConcurrent) manages concurrent Claude subprocesses.
 * - Submits up to maxConcurrent tasks concurrently
 * - Task #5 with max=4 queues until a slot frees
 * - FIFO ordering of queued tasks
 * - killSession stops running process and dequeues next
 * - drain() kills all running, rejects all queued
 * - drain() prevents new submissions
 * - stats() reflects running/queued counts accurately
 * - Failed task frees slot for next queued task
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createProcessPool } from "./pool.js";

// Mock spawnClaude to avoid actually spawning processes
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
  sessionIds: string[];
} {
  const resolvers: Resolver[] = [];
  const rejecters: Rejecter[] = [];
  const sessionIds: string[] = [];

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
    sessionIds.push(task.sessionId);
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

  return { resolvers, rejecters, sessionIds };
}

describe("createProcessPool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reports correct initial stats", () => {
    const pool = createProcessPool(4);
    expect(pool.stats()).toEqual({ running: 0, queued: 0, maxConcurrent: 4 });
  });

  it("submits a task and returns result", async () => {
    const pool = createProcessPool(4);
    const { resolvers } = setupMockSpawn();

    const p = pool.submit({ sessionId: "t1", prompt: "hello" });

    expect(pool.stats().running).toBe(1);

    resolvers[0]({ text: "world", exitCode: 0, duration: 50 });
    const result = await p;

    expect(result.text).toBe("world");
    expect(result.exitCode).toBe(0);
  });

  it("submits up to maxConcurrent tasks concurrently", () => {
    const pool = createProcessPool(3);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    pool.submit({ sessionId: "t2", prompt: "b" });
    pool.submit({ sessionId: "t3", prompt: "c" });

    expect(pool.stats().running).toBe(3);
    expect(pool.stats().queued).toBe(0);
  });

  it("queues tasks when at max concurrency", () => {
    const pool = createProcessPool(2);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    pool.submit({ sessionId: "t2", prompt: "b" });
    pool.submit({ sessionId: "t3", prompt: "c" });

    expect(pool.stats().running).toBe(2);
    expect(pool.stats().queued).toBe(1);
  });

  it("dequeues next task when a slot frees", async () => {
    const pool = createProcessPool(1);
    const { resolvers } = setupMockSpawn();

    const p1 = pool.submit({ sessionId: "t1", prompt: "a" });
    const p2 = pool.submit({ sessionId: "t2", prompt: "b" });

    expect(pool.stats()).toEqual({ running: 1, queued: 1, maxConcurrent: 1 });

    // Complete first task
    resolvers[0]({ text: "r1", exitCode: 0, duration: 10 });
    await p1;

    // Allow microtask to process
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.stats().running).toBe(1);
    expect(pool.stats().queued).toBe(0);

    // Complete second task
    resolvers[1]({ text: "r2", exitCode: 0, duration: 10 });
    const r2 = await p2;
    expect(r2.text).toBe("r2");
  });

  it("maintains FIFO ordering of queued tasks", async () => {
    const pool = createProcessPool(1);
    const { resolvers, sessionIds } = setupMockSpawn();

    pool.submit({ sessionId: "first", prompt: "a" });
    const p2 = pool.submit({ sessionId: "second", prompt: "b" });
    const p3 = pool.submit({ sessionId: "third", prompt: "c" });

    // Complete first
    resolvers[0]({ text: "r1", exitCode: 0, duration: 10 });
    await new Promise((r) => setTimeout(r, 0));

    // "second" should have been spawned next (FIFO)
    expect(sessionIds[1]).toBe("second");

    // Complete second
    resolvers[1]({ text: "r2", exitCode: 0, duration: 10 });
    await p2;
    await new Promise((r) => setTimeout(r, 0));

    // "third" spawned last
    expect(sessionIds[2]).toBe("third");

    resolvers[2]({ text: "r3", exitCode: 0, duration: 10 });
    await p3;
  });

  it("killSession stops running process and triggers dequeue", async () => {
    const pool = createProcessPool(1);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    pool.submit({ sessionId: "t2", prompt: "b" });

    expect(pool.stats()).toEqual({ running: 1, queued: 1, maxConcurrent: 1 });

    const killed = pool.killSession("t1");
    expect(killed).toBe(true);

    // After kill, the queued task should start
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.stats().running).toBe(1);
    expect(pool.stats().queued).toBe(0);
  });

  it("killSession returns false for unknown session", () => {
    const pool = createProcessPool(4);
    expect(pool.killSession("nonexistent")).toBe(false);
  });

  it("drain() kills all running and rejects all queued", async () => {
    const pool = createProcessPool(1);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    const p2 = pool.submit({ sessionId: "t2", prompt: "b" });

    await pool.drain();

    expect(pool.stats().running).toBe(0);
    expect(pool.stats().queued).toBe(0);

    // Queued task should have been rejected
    await expect(p2).rejects.toThrow("draining");
  });

  it("drain() prevents new submissions", async () => {
    const pool = createProcessPool(4);
    await pool.drain();

    await expect(
      pool.submit({ sessionId: "x", prompt: "nope" }),
    ).rejects.toThrow("draining");
  });

  it("stats() reflects running/queued counts accurately through lifecycle", async () => {
    const pool = createProcessPool(2);
    const { resolvers } = setupMockSpawn();

    expect(pool.stats()).toEqual({ running: 0, queued: 0, maxConcurrent: 2 });

    pool.submit({ sessionId: "t1", prompt: "a" });
    expect(pool.stats()).toEqual({ running: 1, queued: 0, maxConcurrent: 2 });

    pool.submit({ sessionId: "t2", prompt: "b" });
    expect(pool.stats()).toEqual({ running: 2, queued: 0, maxConcurrent: 2 });

    pool.submit({ sessionId: "t3", prompt: "c" });
    expect(pool.stats()).toEqual({ running: 2, queued: 1, maxConcurrent: 2 });

    resolvers[0]({ text: "done", exitCode: 0, duration: 10 });
    await new Promise((r) => setTimeout(r, 0));

    expect(pool.stats()).toEqual({ running: 2, queued: 0, maxConcurrent: 2 });
  });

  it("failed task frees slot for next queued task", async () => {
    const pool = createProcessPool(1);
    const { rejecters, resolvers } = setupMockSpawn();

    const p1 = pool.submit({ sessionId: "t1", prompt: "a" });
    const p2 = pool.submit({ sessionId: "t2", prompt: "b" });

    expect(pool.stats()).toEqual({ running: 1, queued: 1, maxConcurrent: 1 });

    // Fail the first task
    rejecters[0](new Error("process crashed"));
    await expect(p1).rejects.toThrow("process crashed");

    // Queued task should now be running
    await new Promise((r) => setTimeout(r, 0));
    expect(pool.stats()).toEqual({ running: 1, queued: 0, maxConcurrent: 1 });

    // Complete second task
    resolvers[1]({ text: "ok", exitCode: 0, duration: 10 });
    const r2 = await p2;
    expect(r2.text).toBe("ok");
  });

  it("lists running sessions", () => {
    const pool = createProcessPool(4);
    setupMockSpawn();

    pool.submit({ sessionId: "s1", prompt: "a" });
    pool.submit({ sessionId: "s2", prompt: "b" });

    const sessions = pool.listSessions();
    expect(sessions).toHaveLength(2);
    expect(sessions.map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("getSession returns session by ID", () => {
    const pool = createProcessPool(4);
    setupMockSpawn();

    pool.submit({ sessionId: "s1", prompt: "a" });

    const session = pool.getSession("s1");
    expect(session).toBeDefined();
    expect(session?.id).toBe("s1");
    expect(session?.status).toBe("running");
  });

  it("getSession returns undefined for unknown ID", () => {
    const pool = createProcessPool(4);
    expect(pool.getSession("nope")).toBeUndefined();
  });

  it("drain() collects PIDs and waits for exit", async () => {
    const pool = createProcessPool(2);
    setupMockSpawn();

    pool.submit({ sessionId: "t1", prompt: "a" });
    pool.submit({ sessionId: "t2", prompt: "b" });

    // drain should still resolve cleanly (mock PIDs don't exist as real processes)
    await pool.drain();

    expect(pool.stats().running).toBe(0);
    expect(pool.stats().queued).toBe(0);
  });
});
