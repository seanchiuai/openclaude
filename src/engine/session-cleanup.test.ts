import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sweepStaleSessions } from "./session-cleanup.js";

describe("sweepStaleSessions", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = mkdtempSync(join(tmpdir(), "sessions-test-"));
  });

  afterEach(() => {
    rmSync(sessionsDir, { recursive: true, force: true });
  });

  it("removes directories older than retention period", () => {
    const oldDir = join(sessionsDir, "old-session");
    mkdirSync(oldDir);
    // Set mtime to 48 hours ago
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(oldDir, past, past);

    const result = sweepStaleSessions(sessionsDir, 24 * 60 * 60 * 1000);

    expect(result.removed).toEqual(["old-session"]);
    expect(result.errors).toEqual([]);
    expect(existsSync(oldDir)).toBe(false);
  });

  it("keeps directories newer than retention period", () => {
    const newDir = join(sessionsDir, "new-session");
    mkdirSync(newDir);
    // Touch file inside to ensure it's recent
    writeFileSync(join(newDir, "prompt.md"), "test");

    const result = sweepStaleSessions(sessionsDir, 24 * 60 * 60 * 1000);

    expect(result.removed).toEqual([]);
    expect(existsSync(newDir)).toBe(true);
  });

  it("handles nonexistent sessions directory gracefully", () => {
    const result = sweepStaleSessions("/nonexistent/path");
    expect(result.removed).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it("ignores files (non-directories) in the sessions directory", () => {
    writeFileSync(join(sessionsDir, "stray-file.txt"), "oops");
    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(join(sessionsDir, "stray-file.txt"), past, past);

    const result = sweepStaleSessions(sessionsDir, 24 * 60 * 60 * 1000);

    expect(result.removed).toEqual([]);
    // File should still exist
    expect(existsSync(join(sessionsDir, "stray-file.txt"))).toBe(true);
  });

  it("removes multiple old directories and keeps new ones", () => {
    const old1 = join(sessionsDir, "old-1");
    const old2 = join(sessionsDir, "old-2");
    const recent = join(sessionsDir, "recent");
    mkdirSync(old1);
    mkdirSync(old2);
    mkdirSync(recent);

    const past = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(old1, past, past);
    utimesSync(old2, past, past);

    const result = sweepStaleSessions(sessionsDir, 24 * 60 * 60 * 1000);

    expect(result.removed.sort()).toEqual(["old-1", "old-2"]);
    expect(existsSync(old1)).toBe(false);
    expect(existsSync(old2)).toBe(false);
    expect(existsSync(recent)).toBe(true);
  });
});
