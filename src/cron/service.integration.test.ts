import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCronService } from "./service.js";
import { clearStoreCache } from "./store.js";
import { createTestContext } from "../../test/helpers/test-context.js";
import type { CronJob, CronRunOutcome } from "./types.js";

describe("cron service integration", () => {
  let tmpDir: string;
  let storePath: string;
  const ctx = createTestContext("cron");

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "openclaude-cron-int-"));
    storePath = join(tmpDir, "jobs.json");
    ctx.dumpOnFailure();
  });

  afterEach(async () => {
    clearStoreCache();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Wait for the fire-and-forget async init in start() to settle. */
  async function tick(ms = 80): Promise<void> {
    await new Promise((r) => setTimeout(r, ms));
  }

  it("CRUD lifecycle: add → list → verify → remove → verify empty", async () => {
    const calls: CronJob[] = [];
    const runIsolatedJob = async (job: CronJob): Promise<CronRunOutcome> => {
      calls.push(job);
      return { status: "ok", summary: "done", durationMs: 1 };
    };

    const cron = createCronService({ storePath, runIsolatedJob });
    cron.start();
    await tick();

    // Initially empty
    expect(cron.list()).toEqual([]);
    expect(cron.status()).toMatchObject({ running: true, jobCount: 0, enabledCount: 0 });
    ctx.log("service started with empty store");

    // Add a job
    const job = cron.add({
      name: "integration-job",
      schedule: { kind: "every", everyMs: 300_000 },
      prompt: "do integration work",
    });

    expect(job.id).toBeTruthy();
    expect(job.name).toBe("integration-job");
    expect(job.enabled).toBe(true);
    expect(job.sessionTarget).toBe("isolated");
    ctx.log("added job", { id: job.id });

    // List returns the job
    const jobs = cron.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);
    expect(cron.status()).toMatchObject({ jobCount: 1, enabledCount: 1 });

    // getJob works
    expect(cron.getJob(job.id)?.name).toBe("integration-job");
    expect(cron.getJob("nonexistent")).toBeUndefined();

    // Remove the job
    expect(cron.remove(job.id)).toBe(true);
    expect(cron.list()).toHaveLength(0);
    expect(cron.status()).toMatchObject({ jobCount: 0, enabledCount: 0 });
    ctx.log("removed job");

    // Removing again returns false
    expect(cron.remove(job.id)).toBe(false);

    cron.stop();
  });

  it("manual run: add job → cron.run(id) → verify runIsolatedJob was called", async () => {
    const calls: CronJob[] = [];
    const runIsolatedJob = async (job: CronJob): Promise<CronRunOutcome> => {
      calls.push(job);
      return { status: "ok", summary: "manual result", durationMs: 42 };
    };

    const cron = createCronService({ storePath, runIsolatedJob });
    cron.start();
    await tick();

    const job = cron.add({
      name: "manual-run-job",
      schedule: { kind: "every", everyMs: 600_000 },
      prompt: "run me manually",
    });

    const outcome = await cron.run(job.id);

    expect(outcome.status).toBe("ok");
    expect(outcome.summary).toBe("manual result");
    ctx.log("manual run completed", { outcome });

    // runIsolatedJob was called with the correct job
    expect(calls).toHaveLength(1);
    expect(calls[0].id).toBe(job.id);
    expect(calls[0].prompt).toBe("run me manually");

    // Job state was updated
    const updated = cron.getJob(job.id);
    expect(updated?.state.lastStatus).toBe("ok");
    expect(updated?.state.lastRunAtMs).toBeGreaterThan(0);
    expect(updated?.state.consecutiveErrors).toBe(0);

    cron.stop();
  });

  it("run with nonexistent id returns error outcome", async () => {
    const cron = createCronService({
      storePath,
      runIsolatedJob: async () => ({ status: "ok", durationMs: 1 }),
    });
    cron.start();
    await tick();

    const outcome = await cron.run("does-not-exist");
    expect(outcome.status).toBe("error");
    expect(outcome.error).toContain("not found");
    ctx.log("nonexistent run returned error as expected");

    cron.stop();
  });

  it("persists jobs across service restarts", async () => {
    const runIsolatedJob = async (): Promise<CronRunOutcome> => ({
      status: "ok",
      durationMs: 1,
    });

    // First instance: add a job
    const cron1 = createCronService({ storePath, runIsolatedJob });
    cron1.start();
    await tick();

    const job = cron1.add({
      name: "persistent-job",
      schedule: { kind: "cron", expr: "0 9 * * *" },
      prompt: "persist across restart",
    });
    await tick(); // let save() settle

    cron1.stop();
    clearStoreCache();
    ctx.log("first instance stopped");

    // Second instance: verify job survived
    const cron2 = createCronService({ storePath, runIsolatedJob });
    cron2.start();
    await tick();

    const jobs = cron2.list();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].id).toBe(job.id);
    expect(jobs[0].name).toBe("persistent-job");
    expect(jobs[0].prompt).toBe("persist across restart");
    ctx.log("second instance loaded persisted job");

    cron2.stop();
  });

  it("onJobComplete callback fires with job and outcome", async () => {
    const completions: Array<{ job: CronJob; outcome: CronRunOutcome }> = [];

    const cron = createCronService({
      storePath,
      runIsolatedJob: async () => ({
        status: "ok",
        summary: "callback test",
        durationMs: 5,
      }),
      onJobComplete: (job, outcome) => {
        completions.push({ job, outcome });
      },
    });
    cron.start();
    await tick();

    const job = cron.add({
      name: "callback-job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "test callback",
    });

    await cron.run(job.id);

    expect(completions).toHaveLength(1);
    expect(completions[0].job.id).toBe(job.id);
    expect(completions[0].outcome.status).toBe("ok");
    ctx.log("onJobComplete fired correctly");

    cron.stop();
  });
});
