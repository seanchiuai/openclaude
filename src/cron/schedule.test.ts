import { describe, it, expect, afterEach } from "vitest";
import {
  computeNextRunAtMs,
  computePreviousRunAtMs,
  clearScheduleCache,
  coerceFiniteScheduleNumber,
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
    expect(next!).toBeGreaterThan(now);
    // With coercion: elapsed=100000, steps = ceil(100000/30000) = 4, next = 0 + 4*30000 = 120000
    expect(next).toBe(120_000);
  });

  it("every schedule: returns anchor when now < anchor", () => {
    const schedule: CronSchedule = {
      kind: "every",
      everyMs: 60_000,
      anchorMs: 200_000,
    };
    expect(computeNextRunAtMs(schedule, 100_000)).toBe(200_000);
  });

  it("every schedule: handles undefined anchorMs (uses nowMs)", () => {
    const now = 100_000;
    const schedule: CronSchedule = {
      kind: "every",
      everyMs: 30_000,
    };
    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    // anchor defaults to nowMs, so next = nowMs + everyMs
    expect(next).toBe(now + 30_000);
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

  it("cron schedule: uses timezone when provided", () => {
    const now = Date.now();
    const schedule: CronSchedule = {
      kind: "cron",
      expr: "0 12 * * *",
      timezone: "America/New_York",
    };

    const next = computeNextRunAtMs(schedule, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(now);
  });
});

describe("computePreviousRunAtMs", () => {
  it("returns undefined for non-cron schedules", () => {
    const now = Date.now();
    const at: CronSchedule = { kind: "at", atMs: now - 5_000 };
    const every: CronSchedule = { kind: "every", everyMs: 60_000 };

    expect(computePreviousRunAtMs(at, now)).toBeUndefined();
    expect(computePreviousRunAtMs(every, now)).toBeUndefined();
  });

  it("cron schedule previousRun: returns time < nowMs", () => {
    const now = Date.now();
    const schedule: CronSchedule = { kind: "cron", expr: "* * * * *" };

    const prev = computePreviousRunAtMs(schedule, now);
    expect(prev).toBeDefined();
    expect(prev!).toBeLessThan(now);
    // Should be within the last 60 seconds for every-minute cron
    expect(now - prev!).toBeLessThanOrEqual(60_000);
  });
});

describe("coerceFiniteScheduleNumber", () => {
  it("coerces valid numbers", () => {
    expect(coerceFiniteScheduleNumber(42)).toBe(42);
    expect(coerceFiniteScheduleNumber(0)).toBe(0);
    expect(coerceFiniteScheduleNumber(-1)).toBe(-1);
  });

  it("rejects non-finite numbers", () => {
    expect(coerceFiniteScheduleNumber(Infinity)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(NaN)).toBeUndefined();
  });

  it("coerces string numbers", () => {
    expect(coerceFiniteScheduleNumber("42")).toBe(42);
    expect(coerceFiniteScheduleNumber(" 100 ")).toBe(100);
  });

  it("rejects empty/invalid strings", () => {
    expect(coerceFiniteScheduleNumber("")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("  ")).toBeUndefined();
    expect(coerceFiniteScheduleNumber("abc")).toBeUndefined();
  });

  it("rejects non-number/string types", () => {
    expect(coerceFiniteScheduleNumber(null)).toBeUndefined();
    expect(coerceFiniteScheduleNumber(undefined)).toBeUndefined();
    expect(coerceFiniteScheduleNumber({})).toBeUndefined();
  });
});
