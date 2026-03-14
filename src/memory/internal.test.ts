import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMultimodalChunkForIndexing,
  buildFileEntry,
  chunkMarkdown,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  remapChunkLines,
  isMemoryPath,
  parseEmbedding,
  cosineSimilarity,
} from "./internal.js";
import {
  DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  type MemoryMultimodalSettings,
} from "./multimodal.js";

function setupTempDirLifecycle(prefix: string): () => string {
  let tmpDir = "";
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
  return () => tmpDir;
}

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

describe("normalizeExtraMemoryPaths", () => {
  it("trims, resolves, and dedupes paths", () => {
    const workspaceDir = path.join(os.tmpdir(), "memory-test-workspace");
    const absPath = path.resolve(path.sep, "shared-notes");
    const result = normalizeExtraMemoryPaths(workspaceDir, [
      " notes ",
      "./notes",
      absPath,
      absPath,
      "",
    ]);
    expect(result).toEqual([path.resolve(workspaceDir, "notes"), absPath]);
  });
});

describe("listMemoryFiles", () => {
  const getTmpDir = setupTempDirLifecycle("memory-test-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

  it("finds MEMORY.md at root", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Memory");
    const files = await listMemoryFiles(tmpDir);
    expect(files).toContain(path.join(tmpDir, "MEMORY.md"));
  });

  it("finds files in memory/ subdirectory", async () => {
    const tmpDir = getTmpDir();
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "memory", "notes.md"), "notes");
    const files = await listMemoryFiles(tmpDir);
    expect(files).toContain(path.join(tmpDir, "memory", "notes.md"));
  });

  it("skips symlinks", async () => {
    const tmpDir = getTmpDir();
    await fs.mkdir(path.join(tmpDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "memory", "real.md"), "# Real");
    try {
      await fs.symlink(
        path.join(tmpDir, "memory", "real.md"),
        path.join(tmpDir, "memory", "link.md"),
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        return; // skip test on platforms without symlink support
      }
      throw err;
    }
    const files = await listMemoryFiles(tmpDir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(tmpDir, "memory", "real.md"));
  });

  it("returns empty when no memory files exist", async () => {
    const tmpDir = getTmpDir();
    const files = await listMemoryFiles(tmpDir);
    expect(files).toEqual([]);
  });

  it("includes files from additional paths (directory)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra-notes");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note1.md"), "# Note 1");
    await fs.writeFile(path.join(extraDir, "note2.md"), "# Note 2");
    await fs.writeFile(path.join(extraDir, "ignore.txt"), "Not a markdown file");

    const files = await listMemoryFiles(tmpDir, [extraDir]);
    expect(files).toHaveLength(3);
    expect(files.some((file) => file.endsWith("MEMORY.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note1.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("note2.md"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.txt"))).toBe(false);
  });

  it("includes files from additional paths (single file)", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const singleFile = path.join(tmpDir, "standalone.md");
    await fs.writeFile(singleFile, "# Standalone");

    const files = await listMemoryFiles(tmpDir, [singleFile]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("standalone.md"))).toBe(true);
  });

  it("handles relative paths in additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "subdir");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "nested.md"), "# Nested");

    const files = await listMemoryFiles(tmpDir, ["subdir"]);
    expect(files).toHaveLength(2);
    expect(files.some((file) => file.endsWith("nested.md"))).toBe(true);
  });

  it("ignores non-existent additional paths", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");

    const files = await listMemoryFiles(tmpDir, ["/does/not/exist"]);
    expect(files).toHaveLength(1);
  });

  it("ignores symlinked files and directories", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const extraDir = path.join(tmpDir, "extra");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "note.md"), "# Note");

    const targetFile = path.join(tmpDir, "target.md");
    await fs.writeFile(targetFile, "# Target");
    const linkFile = path.join(extraDir, "linked.md");

    const targetDir = path.join(tmpDir, "target-dir");
    await fs.mkdir(targetDir, { recursive: true });
    await fs.writeFile(path.join(targetDir, "nested.md"), "# Nested");
    const linkDir = path.join(tmpDir, "linked-dir");

    let symlinksOk = true;
    try {
      await fs.symlink(targetFile, linkFile, "file");
      await fs.symlink(targetDir, linkDir, "dir");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") {
        symlinksOk = false;
      } else {
        throw err;
      }
    }

    const files = await listMemoryFiles(tmpDir, [extraDir, linkDir]);
    expect(files.some((file) => file.endsWith("note.md"))).toBe(true);
    if (symlinksOk) {
      expect(files.some((file) => file.endsWith("linked.md"))).toBe(false);
      expect(files.some((file) => file.endsWith("nested.md"))).toBe(false);
    }
  });

  it("dedupes overlapping extra paths that resolve to the same file", async () => {
    const tmpDir = getTmpDir();
    await fs.writeFile(path.join(tmpDir, "MEMORY.md"), "# Default memory");
    const files = await listMemoryFiles(tmpDir, [tmpDir, ".", path.join(tmpDir, "MEMORY.md")]);
    const memoryMatches = files.filter((file) => file.endsWith("MEMORY.md"));
    expect(memoryMatches).toHaveLength(1);
  });

  it("includes image and audio files from extra paths when multimodal is enabled", async () => {
    const tmpDir = getTmpDir();
    const extraDir = path.join(tmpDir, "media");
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(extraDir, "note.wav"), Buffer.from("wav"));
    await fs.writeFile(path.join(extraDir, "ignore.bin"), Buffer.from("bin"));

    const files = await listMemoryFiles(tmpDir, [extraDir], multimodal);
    expect(files.some((file) => file.endsWith("diagram.png"))).toBe(true);
    expect(files.some((file) => file.endsWith("note.wav"))).toBe(true);
    expect(files.some((file) => file.endsWith("ignore.bin"))).toBe(false);
  });
});

describe("buildFileEntry", () => {
  const getTmpDir = setupTempDirLifecycle("memory-build-entry-");
  const multimodal: MemoryMultimodalSettings = {
    enabled: true,
    modalities: ["image", "audio"],
    maxFileBytes: DEFAULT_MEMORY_MULTIMODAL_MAX_FILE_BYTES,
  };

  it("returns null when the file disappears before reading", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "ghost.md");
    await fs.writeFile(target, "ghost", "utf-8");
    await fs.rm(target);
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).toBeNull();
  });

  it("returns metadata when the file exists", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "note.md");
    await fs.writeFile(target, "hello", "utf-8");
    const entry = await buildFileEntry(target, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry?.path).toBe("note.md");
    expect(entry?.size).toBeGreaterThan(0);
    expect(entry?.kind).toBe("markdown");
  });

  it("builds entry with relative path and hash", async () => {
    const tmpDir = getTmpDir();
    const filePath = path.join(tmpDir, "MEMORY.md");
    await fs.writeFile(filePath, "hello");
    const entry = await buildFileEntry(filePath, tmpDir);
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe("MEMORY.md");
    expect(entry!.absPath).toBe(filePath);
    expect(entry!.hash).toBe(hashText("hello"));
    expect(entry!.size).toBeGreaterThan(0);
  });

  it("returns null for missing file", async () => {
    const tmpDir = getTmpDir();
    const entry = await buildFileEntry(path.join(tmpDir, "nope.md"), tmpDir);
    expect(entry).toBeNull();
  });

  it("returns multimodal metadata for eligible image files", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);

    expect(entry).toMatchObject({
      path: "diagram.png",
      kind: "multimodal",
      modality: "image",
      mimeType: "image/png",
      contentText: "Image file: diagram.png",
    });
  });

  it("builds a multimodal chunk lazily for indexing", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    const built = await buildMultimodalChunkForIndexing(entry!);

    expect(built?.chunk.embeddingInput?.parts).toEqual([
      { type: "text", text: "Image file: diagram.png" },
      expect.objectContaining({ type: "inline-data", mimeType: "image/png" }),
    ]);
    expect(built?.structuredInputBytes).toBeGreaterThan(0);
  });

  it("skips lazy multimodal indexing when the file grows after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.alloc(entry!.size + 32, 1));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
  });

  it("skips lazy multimodal indexing when file bytes change after discovery", async () => {
    const tmpDir = getTmpDir();
    const target = path.join(tmpDir, "diagram.png");
    await fs.writeFile(target, Buffer.from("png"));

    const entry = await buildFileEntry(target, tmpDir, multimodal);
    await fs.writeFile(target, Buffer.from("gif"));

    await expect(buildMultimodalChunkForIndexing(entry!)).resolves.toBeNull();
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
    const lines = Array.from({ length: 50 }, (_, i) => `This is line number ${i + 1}`);
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: 30, overlap: 10 });
    if (chunks.length >= 2) {
      expect(chunks[1].startLine).toBeLessThanOrEqual(chunks[0].endLine);
    }
  });

  it("splits overly long lines into max-sized chunks", () => {
    const chunkTokens = 400;
    const maxChars = chunkTokens * 4;
    const content = "a".repeat(maxChars * 3 + 25);
    const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(maxChars);
    }
  });
});

describe("remapChunkLines", () => {
  it("remaps chunk line numbers using a lineMap", () => {
    const lineMap = [4, 6, 7, 10, 13];
    const content = "User: Hello\nAssistant: Hi\nUser: Question\nAssistant: Answer\nUser: Thanks";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0].startLine).toBe(1);

    remapChunkLines(chunks, lineMap);

    expect(chunks[0].startLine).toBe(4);
    const lastChunk = chunks[chunks.length - 1];
    expect(lastChunk.endLine).toBe(13);
  });

  it("preserves original line numbers when lineMap is undefined", () => {
    const content = "Line one\nLine two\nLine three";
    const chunks = chunkMarkdown(content, { tokens: 400, overlap: 0 });
    const originalStart = chunks[0].startLine;
    const originalEnd = chunks[chunks.length - 1].endLine;

    remapChunkLines(chunks, undefined);

    expect(chunks[0].startLine).toBe(originalStart);
    expect(chunks[chunks.length - 1].endLine).toBe(originalEnd);
  });

  it("handles multi-chunk content with correct remapping", () => {
    const lineMap = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29];
    const contentLines = lineMap.map((_, i) =>
      i % 2 === 0 ? `User: Message ${i}` : `Assistant: Reply ${i}`,
    );
    const content = contentLines.join("\n");

    const chunks = chunkMarkdown(content, { tokens: 10, overlap: 0 });
    expect(chunks.length).toBeGreaterThan(1);

    remapChunkLines(chunks, lineMap);

    expect(chunks[0].startLine).toBe(2);
    expect(chunks[chunks.length - 1].endLine).toBe(29);

    for (const chunk of chunks) {
      expect(chunk.startLine).toBeLessThanOrEqual(chunk.endLine);
    }
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
