import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCronService } from "./service.js";
import { saveCronStore } from "./store.js";
import type { CronJob, CronRunOutcome, CronDeliveryTarget, CronStore } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cron-test-"));
}

describe("CronService", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    storePath = join(tmpDir, "jobs.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts with empty job list", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    expect(svc.list()).toEqual([]);
    expect(svc.status()).toEqual({
      running: true,
      jobCount: 0,
      enabledCount: 0,
    });

    svc.stop();
  });

  it("adds and lists jobs", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const job = svc.add({
      name: "test-job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "do something",
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("test-job");
    expect(job.enabled).toBe(true);
    expect(job.sessionTarget).toBe("isolated");

    const jobs = svc.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);

    expect(svc.status().enabledCount).toBe(1);
    expect(svc.status().jobCount).toBe(1);

    svc.stop();
  });

  it("removes jobs", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const job = svc.add({
      name: "to-remove",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "remove me",
    });

    expect(svc.remove(job.id)).toBe(true);
    expect(svc.list()).toHaveLength(0);
    expect(svc.remove("nonexistent-id")).toBe(false);

    svc.stop();
  });

  it("runs a job manually", async () => {
    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => ({
        status: "ok",
        summary: "done",
        durationMs: 100,
      }),
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
    });
    svc.start();

    const job = svc.add({
      name: "manual-run",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "run me",
    });

    const outcome = await svc.run(job.id);

    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toBe("done");
    expect(runIsolatedJob).toHaveBeenCalledOnce();
    expect(runIsolatedJob.mock.calls[0][0].id).toBe(job.id);

    const updated = svc.getJob(job.id);
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBeGreaterThan(0);
    expect(updated?.state.consecutiveErrors).toBe(0);

    svc.stop();
  });

  it("persists jobs across service restarts", () => {
    const svc1 = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc1.start();

    const job = svc1.add({
      name: "persistent",
      schedule: { kind: "every", everyMs: 120_000 },
      prompt: "persist me",
    });

    svc1.stop();

    const svc2 = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc2.start();

    const jobs = svc2.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);
    expect(jobs[0].name).toBe("persistent");
    expect(jobs[0].prompt).toBe("persist me");

    svc2.stop();
  });

  it("handles job execution errors gracefully", async () => {
    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => {
        throw new Error("something broke");
      },
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
    });
    svc.start();

    const job = svc.add({
      name: "error-job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "will fail",
    });

    const outcome = await svc.run(job.id);

    expect(outcome.status).toBe("error");
    expect(outcome.error).toBe("something broke");

    const updated = svc.getJob(job.id);
    expect(updated?.state.lastStatus).toBe("error");
    expect(updated?.state.lastError).toBe("something broke");
    expect(updated?.state.consecutiveErrors).toBe(1);

    svc.stop();
  });

  it("run() with nonexistent ID returns error outcome", async () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const outcome = await svc.run("does-not-exist");
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("not found");

    svc.stop();
  });

  it("one-shot 'at' job is disabled after successful run", async () => {
    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => ({
        status: "ok",
        summary: "done",
        durationMs: 50,
      }),
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
    });
    svc.start();

    const job = svc.add({
      name: "one-shot",
      schedule: { kind: "at", atMs: Date.now() + 100_000 },
      prompt: "run once",
    });

    await svc.run(job.id);

    expect(svc.getJob(job.id)?.enabled).toBe(false);
    expect(svc.status().enabledCount).toBe(0);

    svc.stop();
  });

  it("one-shot 'at' job remains enabled after error", async () => {
    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => {
        throw new Error("boom");
      },
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
    });
    svc.start();

    const job = svc.add({
      name: "one-shot-error",
      schedule: { kind: "at", atMs: Date.now() + 100_000 },
      prompt: "run once",
    });

    await svc.run(job.id);

    expect(svc.getJob(job.id)?.enabled).toBe(true);

    svc.stop();
  });

  it("consecutive errors increment and reset on success", async () => {
    let shouldFail = true;
    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => {
        if (shouldFail) throw new Error("fail");
        return { status: "ok", summary: "ok", durationMs: 10 };
      },
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
    });
    svc.start();

    const job = svc.add({
      name: "error-counter",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "count errors",
    });

    await svc.run(job.id);
    await svc.run(job.id);
    await svc.run(job.id);

    expect(svc.getJob(job.id)?.state.consecutiveErrors).toBe(3);

    shouldFail = false;
    await svc.run(job.id);

    expect(svc.getJob(job.id)?.state.consecutiveErrors).toBe(0);

    svc.stop();
  });

  it("deliverResult called on ok outcome with summary", async () => {
    const deliverResult = vi.fn<
      (target: CronDeliveryTarget, text: string) => Promise<void>
    >(async () => {});

    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => ({
        status: "ok",
        summary: "test result",
        durationMs: 10,
      }),
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
      deliverResult,
    });
    svc.start();

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const job = svc.add({
      name: "deliver-test",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "deliver me",
      target,
    });

    await svc.run(job.id);

    expect(deliverResult).toHaveBeenCalledOnce();
    expect(deliverResult).toHaveBeenCalledWith(target, "test result");

    svc.stop();
  });

  it("deliverResult NOT called when outcome has no summary", async () => {
    const deliverResult = vi.fn<
      (target: CronDeliveryTarget, text: string) => Promise<void>
    >(async () => {});

    const runIsolatedJob = vi.fn<(job: CronJob) => Promise<CronRunOutcome>>(
      async () => ({
        status: "ok",
        durationMs: 10,
      }),
    );

    const svc = createCronService({
      storePath,
      runIsolatedJob,
      deliverResult,
    });
    svc.start();

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const job = svc.add({
      name: "no-summary",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "no summary",
      target,
    });

    await svc.run(job.id);

    expect(deliverResult).not.toHaveBeenCalled();

    svc.stop();
  });

  it("getJob returns undefined for nonexistent ID", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    expect(svc.getJob("nope")).toBeUndefined();

    svc.stop();
  });

  it("status reflects stopped state after stop()", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();
    svc.stop();

    expect(svc.status().running).toBe(false);
  });

  // ---------- stuck job recovery ----------

  it("clears stuck job on start() (stuck > 2h)", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // Pre-populate store with a job that has been "running" for 3 hours
    const threeHoursAgo = Date.now() - 3 * 60 * 60 * 1000;
    const store: CronStore = {
      version: 1,
      jobs: [
        {
          id: "stuck-job",
          name: "stuck",
          schedule: { kind: "every", everyMs: 60_000 },
          prompt: "stuck prompt",
          sessionTarget: "isolated",
          enabled: true,
          createdAt: threeHoursAgo,
          updatedAt: threeHoursAgo,
          state: {
            runningAtMs: threeHoursAgo,
          },
        },
      ],
    };
    saveCronStore(storePath, store);

    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const job = svc.getJob("stuck-job");
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBe("error");
    expect(job?.state.lastError).toContain("stuck");
    expect(job?.state.consecutiveErrors).toBe(1);

    svc.stop();
    errorSpy.mockRestore();
  });

  it("does NOT clear job running < 2h", () => {
    // Pre-populate store with a job that has been "running" for 1 hour
    const oneHourAgo = Date.now() - 1 * 60 * 60 * 1000;
    const store: CronStore = {
      version: 1,
      jobs: [
        {
          id: "running-job",
          name: "running",
          schedule: { kind: "every", everyMs: 60_000 },
          prompt: "running prompt",
          sessionTarget: "isolated",
          enabled: true,
          createdAt: oneHourAgo,
          updatedAt: oneHourAgo,
          state: {
            runningAtMs: oneHourAgo,
          },
        },
      ],
    };
    saveCronStore(storePath, store);

    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const job = svc.getJob("running-job");
    expect(job?.state.runningAtMs).toBe(oneHourAgo);

    svc.stop();
  });

  it("does NOT affect jobs with no runningAtMs", () => {
    const store: CronStore = {
      version: 1,
      jobs: [
        {
          id: "idle-job",
          name: "idle",
          schedule: { kind: "every", everyMs: 60_000 },
          prompt: "idle prompt",
          sessionTarget: "isolated",
          enabled: true,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          state: {},
        },
      ],
    };
    saveCronStore(storePath, store);

    const svc = createCronService({
      storePath,
      runIsolatedJob: vi.fn(),
    });
    svc.start();

    const job = svc.getJob("idle-job");
    expect(job?.state.runningAtMs).toBeUndefined();
    expect(job?.state.lastStatus).toBeUndefined();

    svc.stop();
  });
});
