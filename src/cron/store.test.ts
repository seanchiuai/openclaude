import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCronStore, saveCronStore } from "./store.js";
import type { CronJob, CronStore } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cron-store-test-"));
}

describe("cron store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns empty store when file missing", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = loadCronStore(join(dir, "nonexistent.json"));
    expect(store.version).toBe(1);
    expect(store.jobs).toEqual([]);
  });

  it("saves and loads store", () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const filePath = join(dir, "sub", "jobs.json");

    const job: CronJob = {
      id: "test-1",
      name: "Test Job",
      schedule: { kind: "every", everyMs: 60_000 },
      prompt: "do something",
      sessionTarget: "isolated",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: {},
    };

    const store: CronStore = { version: 1, jobs: [job] };
    saveCronStore(filePath, store);

    const loaded = loadCronStore(filePath);
    expect(loaded.version).toBe(1);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0].id).toBe("test-1");
    expect(loaded.jobs[0].name).toBe("Test Job");
    expect(loaded.jobs[0].schedule).toEqual({ kind: "every", everyMs: 60_000 });
  });
});
