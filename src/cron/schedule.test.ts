import { describe, it, expect, afterEach } from "vitest";
import {
  computeNextRunAtMs,
  computePrevRunAtMs,
  clearScheduleCache,
} from "./schedule.js";
import type { CronSchedule } from "./types.js";

afterEach(() => {
  clearScheduleCache();
});

describe("computeNextRunAtMs", () => {
  it("at schedule: returns atMs if in future, undefined if in past", () => {
    const now = Date.now();
    const future: CronSchedule = { kind: "at", atMs: now + 10_000 };
    const past: CronSchedule = { kind: "at", atMs: now - 10_000 };

    expect(computeNextRunAtMs(future, now)).toBe(now + 10_000);
    expect(computeNextRunAtMs(past, now)).toBeUndefined();
  });

  it("every schedule: computes next interval", () => {
    const now = 100_000;
    const schedule: CronSchedule = {
      kind: "every",
      everyMs: 30_000,
      anchorMs: 0,
    };

    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThanOrEqual(now);
    // 100_000 / 30_000 = 3.33 -> floor = 3 -> next = (3+1)*30_000 = 120_000
    expect(next).toBe(120_000);
  });

  it("cron schedule: computes next fire time", () => {
    const now = Date.now();
    const schedule: CronSchedule = { kind: "cron", expr: "* * * * *" };

    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(now);
    // Every minute cron should fire within 60 seconds
    expect(next! - now).toBeLessThanOrEqual(60_000);
  });
});

describe("computePrevRunAtMs", () => {
  it("at schedule: returns atMs if in past, undefined if in future", () => {
    const now = Date.now();
    const past: CronSchedule = { kind: "at", atMs: now - 5_000 };
    const future: CronSchedule = { kind: "at", atMs: now + 5_000 };

    expect(computePrevRunAtMs(past, now)).toBe(now - 5_000);
    expect(computePrevRunAtMs(future, now)).toBeUndefined();
  });

  it("cron schedule previousRun: returns time <= nowMs", () => {
    const now = Date.now();
    const schedule: CronSchedule = { kind: "cron", expr: "* * * * *" };

    const prev = computePrevRunAtMs(schedule, now);
    expect(prev).toBeDefined();
    expect(prev!).toBeLessThanOrEqual(now);
    // Should be within the last 60 seconds for every-minute cron
    expect(now - prev!).toBeLessThanOrEqual(60_000);
  });
});
