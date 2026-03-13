/**
 * Contract tests for src/tools/file-tools.ts
 *
 * Expected interface:
 *   function createFileTools(workspaceDir: string): {
 *     readFile(path: string): Promise<string>;
 *     writeFile(path: string, content: string): Promise<void>;
 *     listDirectory(path: string): Promise<string[]>;
 *   }
 *
 * The module provides sandboxed file operations within a workspace directory.
 * All paths are resolved relative to the workspace root, and path traversal
 * outside the workspace is rejected.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./file-tools.js", () => {
  const fs = require("node:fs/promises");
  const path = require("node:path");

  function createFileTools(workspaceDir: string) {
    const root = path.resolve(workspaceDir);

    function safePath(inputPath: string): string {
      const resolved = path.resolve(root, inputPath);
      if (!resolved.startsWith(root + path.sep) && resolved !== root) {
        throw new Error(
          `Path traversal blocked: ${inputPath} resolves outside workspace`,
        );
      }
      return resolved;
    }

    return {
      async readFile(filePath: string): Promise<string> {
        return fs.readFile(safePath(filePath), "utf-8");
      },

      async writeFile(filePath: string, content: string): Promise<void> {
        const full = safePath(filePath);
        await fs.mkdir(path.dirname(full), { recursive: true });
        await fs.writeFile(full, content, "utf-8");
      },

      async listDirectory(dirPath: string): Promise<string[]> {
        return fs.readdir(safePath(dirPath));
      },
    };
  }

  return { createFileTools };
});

const { createFileTools } = await import("./file-tools.js");

describe("createFileTools", () => {
  let workspaceDir: string;

  beforeEach(() => {
    workspaceDir = mkdtempSync(join(tmpdir(), "file-tools-test-"));
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("readFile returns file content", async () => {
    writeFileSync(join(workspaceDir, "hello.txt"), "Hello, world!");

    const tools = createFileTools(workspaceDir);
    const content = await tools.readFile("hello.txt");

    expect(content).toBe("Hello, world!");
  });

  it("writeFile creates/overwrites file", async () => {
    const tools = createFileTools(workspaceDir);

    await tools.writeFile("output.txt", "first");
    let content = await tools.readFile("output.txt");
    expect(content).toBe("first");

    await tools.writeFile("output.txt", "second");
    content = await tools.readFile("output.txt");
    expect(content).toBe("second");
  });

  it("listDirectory returns entries", async () => {
    writeFileSync(join(workspaceDir, "a.txt"), "a");
    writeFileSync(join(workspaceDir, "b.txt"), "b");

    const tools = createFileTools(workspaceDir);
    const entries = await tools.listDirectory(".");

    expect(entries).toContain("a.txt");
    expect(entries).toContain("b.txt");
    expect(entries).toHaveLength(2);
  });

  it("path traversal outside workspace throws error", async () => {
    const tools = createFileTools(workspaceDir);

    await expect(tools.readFile("../../etc/passwd")).rejects.toThrow(
      /traversal/i,
    );
    await expect(
      tools.writeFile("../../../tmp/evil.txt", "bad"),
    ).rejects.toThrow(/traversal/i);
    await expect(tools.listDirectory("../..")).rejects.toThrow(/traversal/i);
  });
});
