/**
 * Stale session directory cleanup.
 *
 * Scans the sessions directory and removes entries whose mtime exceeds
 * the retention window. Called once on gateway startup.
 */
import { readdirSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function sweepStaleSessions(
  sessionsDir: string,
  retentionMs: number = DEFAULT_RETENTION_MS,
): { removed: string[]; errors: string[] } {
  const removed: string[] = [];
  const errors: string[] = [];

  let entries: string[];
  try {
    entries = readdirSync(sessionsDir);
  } catch {
    return { removed, errors };
  }

  const cutoff = Date.now() - retentionMs;

  for (const entry of entries) {
    const full = join(sessionsDir, entry);
    try {
      const stat = statSync(full);
      if (!stat.isDirectory()) continue;
      if (stat.mtimeMs < cutoff) {
        rmSync(full, { recursive: true, force: true });
        removed.push(entry);
      }
    } catch (err) {
      errors.push(`${entry}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { removed, errors };
}
