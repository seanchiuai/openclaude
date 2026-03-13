import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  hashText,
  chunkMarkdown,
  listMemoryFiles,
  buildFileEntry,
  parseEmbedding,
  cosineSimilarity,
  isMemoryPath,
} from "./internal.js";

describe("hashText", () => {
  it("returns consistent hash for same input", () => {
    expect(hashText("hello")).toBe(hashText("hello"));
  });

  it("returns different hashes for different inputs", () => {
    expect(hashText("hello")).not.toBe(hashText("world"));
  });

  it("returns a 64-char hex string", () => {
    const hash = hashText("test");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("chunkMarkdown", () => {
  it("returns empty array for empty content", () => {
    expect(chunkMarkdown("", { tokens: 100, overlap: 10 })).toEqual([]);
  });

  it("returns single chunk for short content", () => {
    const chunks = chunkMarkdown("hello world", { tokens: 100, overlap: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(1);
    expect(chunks[0].text).toBe("hello world");
    expect(chunks[0].hash).toBe(hashText("hello world"));
  });

  it("returns multiple chunks for long content", () => {
    // Each line is ~20 chars, tokens=5 means charLimit=20
    const lines = Array.from({ length: 20 }, (_, i) => `Line number ${i + 1} here`);
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 2 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("tracks line numbers correctly", () => {
    const content = "line1\nline2\nline3\nline4\nline5";
    const chunks = chunkMarkdown(content, { tokens: 1000, overlap: 0 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].startLine).toBe(1);
    expect(chunks[0].endLine).toBe(5);
  });

  it("includes overlap between chunks", () => {
    // Make content large enough to split, with meaningful overlap
    const lines = Array.from({ length: 50 }, (_, i) => `This is line number ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: 30, overlap: 10 });
    if (chunks.length >= 2) {
      // Second chunk should start before the first chunk ends (overlap)
      expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
    }
  });
});

describe("listMemoryFiles", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("finds MEMORY.md at root", async () => {
    await writeFile(join(tmpDir, "MEMORY.md"), "# Memory");
    const files = await listMemoryFiles(tmpDir);
    expect(files).toContain(join(tmpDir, "MEMORY.md"));
  });

  it("finds files in memory/ subdirectory", async () => {
    await mkdir(join(tmpDir, "memory"), { recursive: true });
    await writeFile(join(tmpDir, "memory", "notes.md"), "notes");
    const files = await listMemoryFiles(tmpDir);
    expect(files).toContain(join(tmpDir, "memory", "notes.md"));
  });

  it("skips symlinks", async () => {
    await mkdir(join(tmpDir, "memory"), { recursive: true });
    await writeFile(join(tmpDir, "memory", "real.md"), "# Real");
    await symlink(join(tmpDir, "memory", "real.md"), join(tmpDir, "memory", "link.md"));
    const files = await listMemoryFiles(tmpDir);
    // Should only include real.md, not the symlink
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(join(tmpDir, "memory", "real.md"));
  });

  it("returns empty when no memory files exist", async () => {
    const files = await listMemoryFiles(tmpDir);
    expect(files).toEqual([]);
  });
});

describe("buildFileEntry", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("builds entry with relative path and hash", async () => {
    const filePath = join(tmpDir, "MEMORY.md");
    await writeFile(filePath, "hello");
    const entry = await buildFileEntry(filePath, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("MEMORY.md");
    expect(entry!.absPath).toBe(filePath);
    expect(entry!.hash).toBe(hashText("hello"));
    expect(entry!.size).toBeGreaterThan(0);
  });

  it("returns null for missing file", async () => {
    const entry = await buildFileEntry(join(tmpDir, "nope.md"), tmpDir);
    expect(entry).toBeNull();
  });
});

describe("parseEmbedding", () => {
  it("parses valid JSON array", () => {
    expect(parseEmbedding("[1, 2, 3]")).toEqual([1, 2, 3]);
  });

  it("returns empty array for invalid JSON", () => {
    expect(parseEmbedding("not json")).toEqual([]);
  });

  it("returns empty array for non-array JSON", () => {
    expect(parseEmbedding('{"a": 1}')).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it("returns 0 for mismatched lengths", () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });
});

describe("isMemoryPath", () => {
  it("returns true for MEMORY.md", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(true);
  });

  it("returns true for memory.md", () => {
    expect(isMemoryPath("memory.md")).toBe(true);
  });

  it("returns true for memory/ subdirectory files", () => {
    expect(isMemoryPath("memory/notes.md")).toBe(true);
  });

  it("returns false for other paths", () => {
    expect(isMemoryPath("src/index.ts")).toBe(false);
  });

  it("returns false for similarly named files outside memory", () => {
    expect(isMemoryPath("src/memory.md")).toBe(false);
  });
});
