import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createTestContext } from "../../test/helpers/test-context.js";
import { createMemoryManager, type MemoryManager } from "./manager.js";

const ctx = createTestContext("memory-integration");

let tmpDir: string;
let manager: MemoryManager;

async function setup(): Promise<{ tmpDir: string; manager: MemoryManager }> {
  const dir = join(tmpdir(), `openclaude-mem-integ-${randomUUID()}`);
  await fs.mkdir(dir, { recursive: true });
  const dbPath = join(dir, "memory.sqlite");
  const m = createMemoryManager({ dbPath, workspaceDir: dir });
  ctx.log(`created manager: dir=${dir}`);
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

describe("memory manager integration (FTS-only, real SQLite)", () => {
  it("initializes with zero files and fts-only provider", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    const s = manager.status();
    expect(s.files).toBe(0);
    expect(s.chunks).toBe(0);
    expect(s.provider).toBe("fts-only");
    expect(s.fts.enabled).toBe(true);
  });

  it("syncs markdown files into SQLite and indexes them", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    await fs.writeFile(
      join(tmpDir, "MEMORY.md"),
      "# Project Notes\n\nThe deployment pipeline uses Docker containers.\n",
    );
    const memDir = join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(
      join(memDir, "architecture.md"),
      "# Architecture\n\nThe system follows a microservices pattern with event-driven communication.\n",
    );

    await manager.sync();

    const s = manager.status();
    ctx.log(`post-sync status: files=${s.files} chunks=${s.chunks}`);
    expect(s.files).toBe(2);
    expect(s.chunks).toBeGreaterThanOrEqual(2);
    expect(s.dirty).toBe(false);
  });

  it("searches indexed content via FTS and returns scored results", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    await fs.writeFile(
      join(tmpDir, "MEMORY.md"),
      [
        "# Kubernetes Guide",
        "",
        "Kubernetes orchestrates containerized workloads across clusters.",
        "Pods are the smallest deployable units in Kubernetes.",
        "Services expose pod networking with stable endpoints.",
        "",
        "# Unrelated Topic",
        "",
        "Classical music theory covers harmony and counterpoint.",
        "",
      ].join("\n"),
    );

    await manager.sync();

    const results = await manager.search("kubernetes pods containers");
    ctx.log(`search results: ${results.length}`, results.map((r) => ({ path: r.path, score: r.score })));

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].snippet.toLowerCase()).toMatch(/kubernetes|pod|container/);
    expect(results[0].source).toBe("memory");
    expect(results[0].citation).toMatch(/MEMORY\.md#L\d+-L\d+/);
    expect(results[0].score).toBeGreaterThan(0);
  });

  it("re-syncs after file content changes", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    const filePath = join(tmpDir, "MEMORY.md");
    await fs.writeFile(filePath, "# Old\n\nObsolete information about phlogiston theory.\n");
    await manager.sync();

    const oldResults = await manager.search("phlogiston");
    expect(oldResults.length).toBeGreaterThan(0);

    await fs.writeFile(filePath, "# New\n\nModern thermodynamics and entropy concepts.\n");
    await manager.sync({ force: true });

    const newResults = await manager.search("thermodynamics entropy");
    expect(newResults.length).toBeGreaterThan(0);
    expect(newResults[0].snippet.toLowerCase()).toMatch(/thermodynamics|entropy/);

    const goneResults = await manager.search("phlogiston");
    // After replacement, phlogiston should no longer appear
    const phlogistonInSnippets = goneResults.some((r) =>
      r.snippet.toLowerCase().includes("phlogiston"),
    );
    expect(phlogistonInSnippets).toBe(false);
  });

  it("removes orphaned entries when files are deleted", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    const filePath = join(tmpDir, "MEMORY.md");
    await fs.writeFile(filePath, "# Ephemeral\n\nThis content will vanish.\n");
    await manager.sync();
    expect(manager.status().files).toBe(1);

    await fs.rm(filePath);
    await manager.sync();

    const s = manager.status();
    expect(s.files).toBe(0);
    expect(s.chunks).toBe(0);
  });

  it("reports sync progress", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    const memDir = join(tmpDir, "memory");
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(join(memDir, "a.md"), "# A\n\nAlpha.\n");
    await fs.writeFile(join(memDir, "b.md"), "# B\n\nBravo.\n");
    await fs.writeFile(join(memDir, "c.md"), "# C\n\nCharlie.\n");

    const progressUpdates: Array<{ completed: number; total: number; label: string }> = [];
    await manager.sync({
      progress: (update) => progressUpdates.push(update),
    });

    ctx.log(`progress updates: ${progressUpdates.length}`, progressUpdates);
    expect(progressUpdates.length).toBe(3);
    // Last update should have completed === total
    const last = progressUpdates[progressUpdates.length - 1];
    expect(last.completed).toBe(last.total);
  });

  it("readFile returns content from workspace", async () => {
    ctx.dumpOnFailure();
    ({ tmpDir, manager } = await setup());

    const content = "line one\nline two\nline three\nline four\n";
    await fs.writeFile(join(tmpDir, "MEMORY.md"), content);

    const full = await manager.readFile("MEMORY.md");
    expect(full.text).toBe(content);

    const sliced = await manager.readFile("MEMORY.md", 2, 2);
    expect(sliced.text).toBe("line two\nline three");
  });
});
