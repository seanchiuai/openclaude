import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadCronStore, saveCronStore, clearStoreCache } from "./store.js";
import type { CronJob, CronStore } from "./types.js";

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), "cron-store-test-"));
}

describe("cron store", () => {
  const dirs: string[] = [];

  afterEach(() => {
    clearStoreCache();
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it("returns empty store when file missing", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const store = await loadCronStore(join(dir, "nonexistent.json"));
    expect(store.version).toBe(1);
    expect(store.jobs).toEqual([]);
  });

  it("saves and loads store", async () => {
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
    await saveCronStore(filePath, store);

    const loaded = await loadCronStore(filePath);
    expect(loaded.version).toBe(1);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0].id).toBe("test-1");
    expect(loaded.jobs[0].name).toBe("Test Job");
    expect(loaded.jobs[0].schedule).toEqual({ kind: "every", everyMs: 60_000 });
  });

  it("skips write when content unchanged (serialization cache)", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const filePath = join(dir, "jobs.json");

    const store: CronStore = { version: 1, jobs: [] };
    await saveCronStore(filePath, store);
    // Second save with same content should be a no-op (no error, no crash)
    await saveCronStore(filePath, store);

    const loaded = await loadCronStore(filePath);
    expect(loaded.version).toBe(1);
    expect(loaded.jobs).toEqual([]);
  });

  it("creates backup on save", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const filePath = join(dir, "jobs.json");

    const store1: CronStore = { version: 1, jobs: [] };
    await saveCronStore(filePath, store1);

    clearStoreCache();

    const job: CronJob = {
      id: "test-2",
      name: "New Job",
      schedule: { kind: "every", everyMs: 30_000 },
      prompt: "new",
      sessionTarget: "isolated",
      enabled: true,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      state: {},
    };
    const store2: CronStore = { version: 1, jobs: [job] };
    await saveCronStore(filePath, store2);

    // Backup should exist
    const { readFileSync } = await import("node:fs");
    const backup = JSON.parse(readFileSync(`${filePath}.bak`, "utf-8"));
    expect(backup.jobs).toEqual([]);
  });

  it("handles corrupted JSON gracefully", async () => {
    const dir = makeTmpDir();
    dirs.push(dir);
    const filePath = join(dir, "jobs.json");

    const { writeFileSync } = await import("node:fs");
    writeFileSync(filePath, "not valid json!!!", "utf-8");

    await expect(loadCronStore(filePath)).rejects.toThrow("Failed to parse");
  });
});
