/**
 * Cron job store — persistent JSON file with atomic writes.
 * Adapted from openclaw-source/src/cron/store.ts.
 *
 * Key features copied from OpenClaw:
 * - Async I/O
 * - Serialization cache (skip writes when content unchanged)
 * - Atomic temp-file + rename pattern
 * - Backup creation on save (.bak)
 * - Secure file modes (0o600 files, 0o700 dirs)
 * - Rename retry for Windows EBUSY/EPERM
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CronStore } from "./types.js";

const serializedStoreCache = new Map<string, string>();

export async function loadCronStore(filePath: string): Promise<CronStore> {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${filePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    const store: CronStore = {
      version: 1,
      jobs: jobs.filter(Boolean) as never as CronStore["jobs"],
    };
    serializedStoreCache.set(filePath, JSON.stringify(store, null, 2));
    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(filePath);
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

type SaveCronStoreOptions = {
  skipBackup?: boolean;
};

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

export async function saveCronStore(
  filePath: string,
  store: CronStore,
  opts?: SaveCronStoreOptions,
): Promise<void> {
  const storeDir = path.dirname(filePath);
  await fs.promises.mkdir(storeDir, { recursive: true, mode: 0o700 });
  await fs.promises.chmod(storeDir, 0o700).catch(() => undefined);
  const json = JSON.stringify(store, null, 2);
  const cached = serializedStoreCache.get(filePath);
  if (cached === json) {
    return;
  }

  // Check if file on disk already matches (handles cross-process edits)
  let previous: string | null = cached ?? null;
  if (previous === null) {
    try {
      previous = await fs.promises.readFile(filePath, "utf-8");
    } catch (err) {
      if ((err as { code?: unknown }).code !== "ENOENT") {
        throw err;
      }
    }
  }
  if (previous === json) {
    serializedStoreCache.set(filePath, json);
    return;
  }

  // Atomic write: temp file → rename
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, json, { encoding: "utf-8", mode: 0o600 });
  await setSecureFileMode(tmp);

  // Best-effort backup of previous version
  if (previous !== null && !opts?.skipBackup) {
    try {
      const backupPath = `${filePath}.bak`;
      await fs.promises.copyFile(filePath, backupPath);
      await setSecureFileMode(backupPath);
    } catch {
      // best-effort
    }
  }

  await renameWithRetry(tmp, filePath);
  await setSecureFileMode(filePath);
  serializedStoreCache.set(filePath, json);
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      // Windows doesn't reliably support atomic replace via rename when dest exists.
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}

/**
 * Clear the in-memory serialization cache. Useful for tests.
 */
export function clearStoreCache(): void {
  serializedStoreCache.clear();
}
