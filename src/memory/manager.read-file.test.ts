/**
 * Tests for MemoryIndexManager.readFile — path traversal protection and line slicing.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEmbeddingMocks } from "./test-embeddings-mock.js";
import type { MemoryIndexManager } from "./index.js";
import { buildTestMemoryConfig, getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("MemoryIndexManager.readFile", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaude-mem-read-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
  });

  afterEach(async () => {
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("returns empty text when the requested file does not exist", async () => {
    const memoryConfig = buildTestMemoryConfig({ workspaceDir, indexPath });
    manager = await getRequiredMemoryIndexManager({ memoryConfig, workspaceDir });

    const relPath = "memory/2099-01-01.md";
    const result = await manager.readFile({ relPath });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns content slices when the file exists", async () => {
    const relPath = "memory/2026-02-20.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["line 1", "line 2", "line 3"].join("\n"), "utf-8");

    const memoryConfig = buildTestMemoryConfig({ workspaceDir, indexPath });
    manager = await getRequiredMemoryIndexManager({ memoryConfig, workspaceDir });

    const result = await manager.readFile({ relPath, from: 2, lines: 1 });
    expect(result).toEqual({ text: "line 2", path: relPath });
  });

  it("returns empty text when the requested slice is past EOF", async () => {
    const relPath = "memory/window.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, ["alpha", "beta"].join("\n"), "utf-8");

    const memoryConfig = buildTestMemoryConfig({ workspaceDir, indexPath });
    manager = await getRequiredMemoryIndexManager({ memoryConfig, workspaceDir });

    const result = await manager.readFile({ relPath, from: 10, lines: 5 });
    expect(result).toEqual({ text: "", path: relPath });
  });

  it("returns empty text when the file disappears after stat", async () => {
    const relPath = "memory/transient.md";
    const absPath = path.join(workspaceDir, relPath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, "first\nsecond", "utf-8");

    const memoryConfig = buildTestMemoryConfig({ workspaceDir, indexPath });
    manager = await getRequiredMemoryIndexManager({ memoryConfig, workspaceDir });

    const realReadFile = fs.readFile;
    let injected = false;
    const readSpy = vi
      .spyOn(fs, "readFile")
      .mockImplementation(async (...args: Parameters<typeof realReadFile>) => {
        const [target, options] = args;
        if (!injected && typeof target === "string" && path.resolve(target) === absPath) {
          injected = true;
          const err = new Error("missing") as NodeJS.ErrnoException;
          err.code = "ENOENT";
          throw err;
        }
        return realReadFile(target, options);
      });

    const result = await manager.readFile({ relPath });
    expect(result).toEqual({ text: "", path: relPath });

    readSpy.mockRestore();
  });
});
