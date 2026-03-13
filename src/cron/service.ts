import { randomUUID } from "node:crypto";
import type {
  CronJob,
  CronRunOutcome,
  CronDeliveryTarget,
  CronStore,
} from "./types.js";
import { loadCronStore, saveCronStore } from "./store.js";
import { computeNextRunAtMs } from "./schedule.js";

const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;
const STUCK_RUN_MS = 2 * 60 * 60 * 1000; // 2 hours

export interface CronServiceDeps {
  storePath: string;
  runIsolatedJob: (job: CronJob) => Promise<CronRunOutcome>;
  deliverResult?: (target: CronDeliveryTarget, text: string) => Promise<void>;
}

export interface CronService {
  start(): void;
  stop(): void;
  list(): CronJob[];
  add(input: {
    name: string;
    schedule: CronJob["schedule"];
    prompt: string;
    target?: CronDeliveryTarget;
    sessionTarget?: CronJob["sessionTarget"];
  }): CronJob;
  remove(id: string): boolean;
  run(id: string): Promise<CronRunOutcome>;
  getJob(id: string): CronJob | undefined;
  status(): { running: boolean; jobCount: number; enabledCount: number };
}

export function createCronService(deps: CronServiceDeps): CronService {
  let store: CronStore = { version: 1, jobs: [] };
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let executing = false;

  async function save(): Promise<void> {
    await saveCronStore(deps.storePath, store);
  }

  function armTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (!running) return;

    const now = Date.now();
    let earliest: number | undefined;
    for (const job of store.jobs) {
      if (!job.enabled || job.state.nextRunAtMs === undefined) continue;
      if (earliest === undefined || job.state.nextRunAtMs < earliest) {
        earliest = job.state.nextRunAtMs;
      }
    }

    if (earliest === undefined) return;

    const delay = Math.max(
      MIN_REFIRE_GAP_MS,
      Math.min(earliest - now, MAX_TIMER_DELAY_MS),
    );

    timer = setTimeout(() => {
      void onTick();
    }, delay);
  }

  async function onTick(): Promise<void> {
    if (!running || executing) return;
    executing = true;

    try {
      try {
        store = await loadCronStore(deps.storePath);
      } catch {
        // If store is corrupted mid-run, keep using in-memory state
        return;
      }
      const now = Date.now();

      // Clear stuck jobs on each tick
      let stuckCleared = false;
      for (const job of store.jobs) {
        if (job.state.runningAtMs !== undefined && now - job.state.runningAtMs > STUCK_RUN_MS) {
          console.error(`[cron] Clearing stuck job "${job.name}"`);
          job.state.runningAtMs = undefined;
          job.state.lastStatus = "error";
          job.state.lastError = "Cleared: stuck for over 2 hours";
          job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
          stuckCleared = true;
        }
      }
      if (stuckCleared) {
        await save();
      }

      const dueJobs = store.jobs.filter(
        (j) =>
          j.enabled &&
          j.state.nextRunAtMs !== undefined &&
          j.state.nextRunAtMs <= now &&
          j.state.runningAtMs === undefined,
      );

      for (const job of dueJobs) {
        if (!running) break;
        await executeJob(job);
      }
    } finally {
      executing = false;
      if (running) {
        armTimer();
      }
    }
  }

  async function executeJob(job: CronJob): Promise<CronRunOutcome> {
    const now = Date.now();
    job.state.runningAtMs = now;
    await save();

    let outcome: CronRunOutcome;
    try {
      outcome = await deps.runIsolatedJob(job);
    } catch (err: unknown) {
      const message =
        err instanceof Error ? err.message : String(err);
      outcome = { status: "error", error: message };
    }

    const endMs = Date.now();
    job.state.runningAtMs = undefined;
    job.state.lastRunAtMs = endMs;
    job.state.lastStatus = outcome.status;

    if (outcome.status === "error") {
      job.state.lastError = outcome.error;
      job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
    } else {
      job.state.lastError = undefined;
      job.state.consecutiveErrors = 0;
    }

    // Disable one-shot "at" jobs after successful run
    if (outcome.status === "ok" && job.schedule.kind === "at") {
      job.enabled = false;
    }

    job.state.nextRunAtMs = job.enabled
      ? computeNextRunAtMs(job.schedule, endMs)
      : undefined;
    job.updatedAt = endMs;

    await save();

    // Deliver result if configured
    if (
      deps.deliverResult &&
      job.target &&
      outcome.status === "ok" &&
      outcome.summary
    ) {
      try {
        await deps.deliverResult(job.target, outcome.summary);
      } catch {
        // delivery failure is non-fatal
      }
    }

    return outcome;
  }

  return {
    start() {
      running = true;
      // Fire-and-forget async load — keeps public interface sync
      void (async () => {
        try {
          store = await loadCronStore(deps.storePath);
        } catch (err) {
          console.error("[cron] Failed to load store, starting empty:", err);
          store = { version: 1, jobs: [] };
        }
        const now = Date.now();

        // Clear stuck jobs (e.g. from a previous crash)
        let stuckCleared = false;
        for (const job of store.jobs) {
          if (job.state.runningAtMs !== undefined && now - job.state.runningAtMs > STUCK_RUN_MS) {
            console.error(`[cron] Clearing stuck job "${job.name}"`);
            job.state.runningAtMs = undefined;
            job.state.lastStatus = "error";
            job.state.lastError = "Cleared: stuck for over 2 hours";
            job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
            stuckCleared = true;
          }
        }

        for (const job of store.jobs) {
          if (job.enabled) {
            job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, now);
          }
        }

        if (stuckCleared || store.jobs.length > 0) {
          await save();
        }
        armTimer();
      })();
    },

    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
    },

    list(): CronJob[] {
      return [...store.jobs];
    },

    add(input) {
      const now = Date.now();
      const job: CronJob = {
        id: randomUUID(),
        name: input.name,
        schedule: input.schedule,
        prompt: input.prompt,
        target: input.target,
        sessionTarget: input.sessionTarget ?? "isolated",
        enabled: true,
        createdAt: now,
        updatedAt: now,
        state: {
          nextRunAtMs: computeNextRunAtMs(input.schedule, now),
        },
      };

      store.jobs.push(job);
      void save().catch(() => {});
      armTimer();
      return job;
    },

    remove(id: string): boolean {
      const idx = store.jobs.findIndex((j) => j.id === id);
      if (idx === -1) return false;
      store.jobs.splice(idx, 1);
      void save().catch(() => {});
      return true;
    },

    async run(id: string): Promise<CronRunOutcome> {
      const job = store.jobs.find((j) => j.id === id);
      if (!job) {
        return { status: "error", error: `Job not found: ${id}` };
      }
      return executeJob(job);
    },

    getJob(id: string): CronJob | undefined {
      return store.jobs.find((j) => j.id === id);
    },

    status() {
      return {
        running,
        jobCount: store.jobs.length,
        enabledCount: store.jobs.filter((j) => j.enabled).length,
      };
    },
  };
}
