/**
 * Temporal decay for dated memory files, extracted from OpenClaw.
 * Exponential decay based on file age and configurable half-life.
 */

import { stat } from "node:fs/promises";
import { resolve } from "node:path";

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = Math.LN2 / params.halfLifeDays;
  return Math.exp(-lambda * params.ageInDays);
}

const DATED_PATH_RE = /(\d{4})-(\d{2})-(\d{2})\.md$/;
const EVERGREEN_RE = /(?:^|[/\\])(?:MEMORY|memory)\.md$|(?:^|[/\\])memory[/\\][^/\\]*\.md$/;

function isEvergreenPath(path: string): boolean {
  if (EVERGREEN_RE.test(path)) {
    // Exclude dated files inside memory/ dir
    return !DATED_PATH_RE.test(path);
  }
  return false;
}

function parseDateFromPath(path: string): number | null {
  const match = DATED_PATH_RE.exec(path);
  if (!match) return null;
  const [, year, month, day] = match;
  const date = new Date(`${year}-${month}-${day}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return date.getTime();
}

export async function applyTemporalDecay<
  T extends { path: string; score: number; source: string },
>(
  results: T[],
  config: TemporalDecayConfig,
  workspaceDir?: string,
  nowMs?: number,
): Promise<T[]> {
  if (!config.enabled) {
    return [...results];
  }

  const now = nowMs ?? Date.now();
  const msPerDay = 86_400_000;
  const timestampCache = new Map<string, number | null>();

  async function getTimestamp(path: string): Promise<number | null> {
    if (timestampCache.has(path)) {
      return timestampCache.get(path) as number | null;
    }

    // Try parsing date from path first
    const pathDate = parseDateFromPath(path);
    if (pathDate !== null) {
      timestampCache.set(path, pathDate);
      return pathDate;
    }

    // Fallback to file mtime
    try {
      const absPath = workspaceDir ? resolve(workspaceDir, path) : path;
      const st = await stat(absPath);
      timestampCache.set(path, st.mtimeMs);
      return st.mtimeMs;
    } catch {
      timestampCache.set(path, null);
      return null;
    }
  }

  const output: T[] = [];

  for (const result of results) {
    if (isEvergreenPath(result.path)) {
      output.push({ ...result });
      continue;
    }

    const ts = await getTimestamp(result.path);
    if (ts === null) {
      output.push({ ...result });
      continue;
    }

    const ageInDays = Math.max(0, (now - ts) / msPerDay);
    const multiplier = calculateTemporalDecayMultiplier({
      ageInDays,
      halfLifeDays: config.halfLifeDays,
    });
    output.push({ ...result, score: result.score * multiplier });
  }

  return output;
}
