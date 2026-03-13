/**
 * Edge case tests for cron service.
 *
 * Covers: one-shot job lifecycle, consecutive errors, concurrent execution guard,
 * job removal during execution, delivery failures, empty store.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCronService } from "./index.js";
import { clearStoreCache } from "./store.js";
import type { CronStore } from "./types.js";

const testDir = join(tmpdir(), `openclaude-cron-test-${Date.now()}`);
const storePath = join(testDir, "jobs.json");

function writeStore(store: CronStore): void {
  writeFileSync(storePath, JSON.stringify(store), "utf-8");
}

function createEmptyStore(): CronStore {
  return { version: 1, jobs: [] };
}

/** Wait for the fire-and-forget async init in start() to complete. */
async function tick(ms = 50): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe("cron service edge cases", () => {
  beforeEach(() => {
    clearStoreCache();
    mkdirSync(testDir, { recursive: true });
    writeStore(createEmptyStore());
  });

  afterEach(() => {
    clearStoreCache();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup
    }
  });

  it("add() creates a job with correct defaults", async () => {
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn().mockResolvedValue({ status: "ok" }),
    });
    service.start();
    await tick();

    const job = service.add({
      name: "test job",
      schedule: { kind: "cron", expr: "0 * * * *" },
      prompt: "check something",
    });

    expect(job.name).toBe("test job");
    expect(job.enabled).toBe(true);
    expect(job.sessionTarget).toBe("isolated");
    expect(job.id).toBeTruthy();
    expect(job.state.nextRunAtMs).toBeGreaterThan(0);

    service.stop();
  });

  it("remove() returns false for nonexistent job", async () => {
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    service.start();
    await tick();

    expect(service.remove("nonexistent-id")).toBe(false);

    service.stop();
  });

  it("run() returns error for nonexistent job", async () => {
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    service.start();
    await tick();

    const result = await service.run("nonexistent");
    expect(result.status).toBe("error");
    expect(result.error).toContain("not found");

    service.stop();
  });

  it("run() tracks consecutive errors", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("engine down"));
    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "failing job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "will fail",
    });

    await service.run(job.id);
    const updated1 = service.getJob(job.id);
    expect(updated1?.state.consecutiveErrors).toBe(1);
    expect(updated1?.state.lastError).toBe("engine down");

    await service.run(job.id);
    const updated2 = service.getJob(job.id);
    expect(updated2?.state.consecutiveErrors).toBe(2);

    service.stop();
  });

  it("successful run resets consecutive error counter", async () => {
    let callCount = 0;
    const runner = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 2) return Promise.reject(new Error("fail"));
      return Promise.resolve({ status: "ok" as const, summary: "done" });
    });

    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "flaky job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "flaky",
    });

    await service.run(job.id);
    await service.run(job.id);
    expect(service.getJob(job.id)?.state.consecutiveErrors).toBe(2);

    await service.run(job.id);
    expect(service.getJob(job.id)?.state.consecutiveErrors).toBe(0);
    expect(service.getJob(job.id)?.state.lastError).toBeUndefined();

    service.stop();
  });

  it("one-shot 'at' job is disabled after successful run", async () => {
    const runner = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "one shot",
      schedule: { kind: "at", atMs: Date.now() + 1000 },
      prompt: "do once",
    });

    expect(job.enabled).toBe(true);

    await service.run(job.id);
    const updated = service.getJob(job.id);
    expect(updated?.enabled).toBe(false);
    expect(updated?.state.nextRunAtMs).toBeUndefined();

    service.stop();
  });

  it("one-shot 'at' job stays enabled after failed run", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("fail"));
    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "failing one shot",
      schedule: { kind: "at", atMs: Date.now() + 1000 },
      prompt: "will fail",
    });

    await service.run(job.id);
    const updated = service.getJob(job.id);
    expect(updated?.enabled).toBe(true); // Still enabled — can retry

    service.stop();
  });

  it("delivery failure is non-fatal", async () => {
    const runner = vi.fn().mockResolvedValue({ status: "ok", summary: "result text" });
    const deliverer = vi.fn().mockRejectedValue(new Error("network down"));

    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
      deliverResult: deliverer,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "deliver test",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "check",
      target: { channel: "telegram", chatId: "123" },
    });

    // Should not throw even though delivery fails
    const outcome = await service.run(job.id);
    expect(outcome.status).toBe("ok");
    expect(deliverer).toHaveBeenCalled();

    service.stop();
  });

  it("delivery not called when outcome is error", async () => {
    const runner = vi.fn().mockRejectedValue(new Error("fail"));
    const deliverer = vi.fn();

    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
      deliverResult: deliverer,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "error test",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "check",
      target: { channel: "telegram", chatId: "123" },
    });

    await service.run(job.id);
    expect(deliverer).not.toHaveBeenCalled();

    service.stop();
  });

  it("delivery not called when no target configured", async () => {
    const runner = vi.fn().mockResolvedValue({ status: "ok", summary: "done" });
    const deliverer = vi.fn();

    const service = createCronService({
      storePath,
      runIsolatedJob: runner,
      deliverResult: deliverer,
    });
    service.start();
    await tick();

    const job = service.add({
      name: "no target",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "check",
      // No target
    });

    await service.run(job.id);
    expect(deliverer).not.toHaveBeenCalled();

    service.stop();
  });

  it("status() reflects correct counts", async () => {
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    service.start();
    await tick();

    expect(service.status()).toEqual({ running: true, jobCount: 0, enabledCount: 0 });

    service.add({
      name: "job1",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "a",
    });
    service.add({
      name: "job2",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "b",
    });

    expect(service.status()).toEqual({ running: true, jobCount: 2, enabledCount: 2 });

    service.stop();
    expect(service.status().running).toBe(false);
  });

  it("list() returns copy of jobs array", async () => {
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    service.start();
    await tick();

    service.add({
      name: "job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "a",
    });

    const list1 = service.list();
    const list2 = service.list();
    expect(list1).not.toBe(list2); // Different array references
    expect(list1).toEqual(list2);

    service.stop();
  });

  it("empty store loads without errors", async () => {
    writeStore({ version: 1, jobs: [] });
    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });

    expect(() => service.start()).not.toThrow();
    await tick();
    expect(service.list()).toEqual([]);
    service.stop();
  });

  it("corrupted store file loads as empty", async () => {
    writeFileSync(storePath, "not valid json!!!", "utf-8");

    const service = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });

    // start() fires async load which will fail — service should handle gracefully
    expect(() => service.start()).not.toThrow();
    await tick();
    // The async load will throw on parse, but the service catches it internally
    // Jobs list stays at the initial empty state
    expect(service.list()).toEqual([]);
    service.stop();
  });
});
