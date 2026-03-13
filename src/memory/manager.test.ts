import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { createMemoryManager, type MemoryManager } from "./manager.js";

let tmpDir: string;
let manager: MemoryManager;

async function setup(): Promise<{ tmpDir: string; manager: MemoryManager }> {
  const dir = join(tmpdir(), `openclaude-test-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const dbPath = join(dir, "test.sqlite");
  const m = createMemoryManager({ dbPath, workspaceDir: dir });
  return { tmpDir: dir, manager: m };
}

afterEach(async () => {
  if (manager) {
    try {
      manager.close();
    } catch {
      // already closed
    }
  }
  if (tmpDir) {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

describe("createMemoryManager", () => {
  it("creates manager and reports status (files=0, chunks=0, provider=fts-only)", async () => {
    ({ tmpDir, manager } = await setup());
    const s = manager.status();
    expect(s.files).toBe(0);
    expect(s.chunks).toBe(0);
    expect(s.provider).toBe("fts-only");
    expect(s.dirty).toBe(true);
  });

  it("syncs memory files and indexes them", async () => {
    ({ tmpDir, manager } = await setup());
    await fs.writeFile(
      join(tmpDir, "MEMORY.md"),
      "# Notes\n\nSome important memory content here.\n",
    );
    await manager.sync();

    const s = manager.status();
    expect(s.files).toBeGreaterThan(0);
    expect(s.chunks).toBeGreaterThan(0);
    expect(s.dirty).toBe(false);
  });

  it("searches indexed content", async () => {
    ({ tmpDir, manager } = await setup());
    await fs.writeFile(
      join(tmpDir, "MEMORY.md"),
      "# Quantum Physics\n\nQuantum entanglement allows particles to be correlated across vast distances.\nThis phenomenon was described by Einstein as spooky action at a distance.\n",
    );
    await manager.sync();

    const results = await manager.search("quantum entanglement");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("entanglement");
    expect(results[0].citation).toMatch(/MEMORY\.md#L\d+-L\d+/);
    expect(results[0].source).toBe("memory");
  });

  it("detects file changes on re-sync", async () => {
    ({ tmpDir, manager } = await setup());
    const memPath = join(tmpDir, "MEMORY.md");

    await fs.writeFile(memPath, "# Version 1\n\nAlpha bravo charlie.\n");
    await manager.sync();

    await fs.writeFile(
      memPath,
      "# Version 2\n\nXylophone zeppelin wonderland.\n",
    );
    await manager.sync();

    const results = await manager.search("xylophone zeppelin");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet).toContain("zeppelin");
  });

  it("indexes memory/ subdirectory files", async () => {
    ({ tmpDir, manager } = await setup());
    const memDir = join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });

    await fs.writeFile(
      join(memDir, "2026-01-01.md"),
      "# January First\n\nNew year celebrations and fireworks.\n",
    );
    await fs.writeFile(
      join(memDir, "2026-01-02.md"),
      "# January Second\n\nRecovery day and resolutions.\n",
    );
    await manager.sync();

    const s = manager.status();
    expect(s.files).toBe(2);
    expect(s.chunks).toBeGreaterThanOrEqual(2);
  });

  it("readFile reads from workspace with line slicing", async () => {
    ({ tmpDir, manager } = await setup());
    const content = "line one\nline two\nline three\nline four\nline five\n";
    await fs.writeFile(join(tmpDir, "MEMORY.md"), content);

    const full = await manager.readFile("MEMORY.md");
    expect(full.text).toBe(content);

    const sliced = await manager.readFile("MEMORY.md", 2, 2);
    expect(sliced.text).toBe("line two\nline three");
  });

  it("readFile rejects paths outside workspace", async () => {
    ({ tmpDir, manager } = await setup());
    await expect(
      manager.readFile("../../etc/passwd"),
    ).rejects.toThrow("Path traversal detected");
  });

  it("removes orphaned files on sync", async () => {
    ({ tmpDir, manager } = await setup());
    const memPath = join(tmpDir, "MEMORY.md");

    await fs.writeFile(memPath, "# Temporary\n\nThis will be removed.\n");
    await manager.sync();
    expect(manager.status().files).toBe(1);

    await fs.rm(memPath);
    await manager.sync();
    expect(manager.status().files).toBe(0);
    expect(manager.status().chunks).toBe(0);
  });
});
