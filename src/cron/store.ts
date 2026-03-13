import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { CronStore } from "./types.js";

const EMPTY_STORE: CronStore = { version: 1, jobs: [] };

export function loadCronStore(filePath: string): CronStore {
  try {
    const raw = readFileSync(filePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>).jobs)
    ) {
      return { ...EMPTY_STORE, jobs: [] };
    }
    const store = parsed as CronStore;
    return { version: store.version ?? 1, jobs: store.jobs };
  } catch {
    return { ...EMPTY_STORE, jobs: [] };
  }
}

export function saveCronStore(filePath: string, store: CronStore): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const tmpPath = `${filePath}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), {
    encoding: "utf-8",
    mode: 0o600,
  });
  renameSync(tmpPath, filePath);
}
