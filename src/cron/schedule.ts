import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

interface CacheEntry {
  cron: Cron;
  key: string;
}

const MAX_CACHE = 512;
const cache = new Map<string, CacheEntry>();

function cacheKey(expr: string, timezone?: string): string {
  return timezone ? `${expr}|${timezone}` : expr;
}

function getCron(expr: string, timezone?: string): Cron {
  const key = cacheKey(expr, timezone);
  const existing = cache.get(key);
  if (existing) {
    // Move to end (LRU refresh)
    cache.delete(key);
    cache.set(key, existing);
    return existing.cron;
  }

  const cron = new Cron(expr, { timezone, paused: true });
  const entry: CacheEntry = { cron, key };

  if (cache.size >= MAX_CACHE) {
    // Evict oldest entry
    const firstKey = cache.keys().next().value as string;
    cache.delete(firstKey);
  }

  cache.set(key, entry);
  return cron;
}

export function computeNextRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "at": {
      return schedule.atMs > nowMs ? schedule.atMs : undefined;
    }
    case "every": {
      const anchor = schedule.anchorMs ?? 0;
      const elapsed = nowMs - anchor;
      const periods = Math.floor(elapsed / schedule.everyMs);
      const next = anchor + (periods + 1) * schedule.everyMs;
      return next;
    }
    case "cron": {
      const cron = getCron(schedule.expr, schedule.timezone);
      const from = new Date(nowMs);
      const next = cron.nextRun(from);
      return next ? next.getTime() : undefined;
    }
  }
}

export function computePrevRunAtMs(
  schedule: CronSchedule,
  nowMs: number,
): number | undefined {
  switch (schedule.kind) {
    case "at": {
      return schedule.atMs <= nowMs ? schedule.atMs : undefined;
    }
    case "every": {
      const anchor = schedule.anchorMs ?? 0;
      if (nowMs < anchor) return undefined;
      const elapsed = nowMs - anchor;
      const periods = Math.floor(elapsed / schedule.everyMs);
      return anchor + periods * schedule.everyMs;
    }
    case "cron": {
      const cron = getCron(schedule.expr, schedule.timezone);
      const from = new Date(nowMs);
      const runs = cron.previousRuns(1, from);
      const prev = runs.length > 0 ? runs[0] : null;
      return prev ? prev.getTime() : undefined;
    }
  }
}

export function clearScheduleCache(): void {
  cache.clear();
}
