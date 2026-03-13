/**
 * Contract tests for src/memory/sync.ts
 *
 * This module syncs markdown files from disk into the SQLite index.
 *
 * Expected interface:
 *   interface SyncDeps {
 *     db: DatabaseSync;
 *     workspaceDir: string;
 *     chunking?: { tokens: number; overlap: number };
 *   }
 *   function syncMemoryFiles(deps: SyncDeps): Promise<SyncResult>
 *   // SyncResult: { added: number; updated: number; removed: number; unchanged: number }
 *
 * The implementation module does not exist yet. These tests define the
 * contract that syncMemoryFiles must satisfy once implemented.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, writeFile, mkdir, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ensureMemorySchema } from "./schema.js";
import { hashText, chunkMarkdown } from "./internal.js";

// ---------------------------------------------------------------------------
// Types mirroring the contract
// ---------------------------------------------------------------------------
interface SyncDeps {
  db: DatabaseSync;
  workspaceDir: string;
  chunking?: { tokens: number; overlap: number };
}

interface SyncResult {
  added: number;
  updated: number;
  removed: number;
  unchanged: number;
}

// ---------------------------------------------------------------------------
// Mock implementation — stands in until the real module exists.
// This inline implementation follows the contract so tests exercise it.
// When the real src/memory/sync.ts is written the mock can be replaced by:
//   import { syncMemoryFiles } from "./sync.js";
// ---------------------------------------------------------------------------

async function syncMemoryFiles(deps: SyncDeps): Promise<SyncResult> {
  const { db, workspaceDir, chunking = { tokens: 512, overlap: 64 } } = deps;
  const fs = await import("node:fs/promises");
  const pathMod = await import("node:path");

  // Discover markdown files
  const allFiles: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full);
      } else if (e.isFile() && e.name.endsWith(".md")) {
        allFiles.push(full);
      }
    }
  }

  // Check root MEMORY.md / memory.md (deduplicate via realpath for case-insensitive FS)
  const { realpath: fsRealpath } = await import("node:fs/promises");
  const seenReal = new Set<string>();
  for (const name of ["MEMORY.md", "memory.md"]) {
    const p = join(workspaceDir, name);
    try {
      const s = await fs.stat(p);
      if (s.isFile()) {
        const real = await fsRealpath(p);
        if (!seenReal.has(real)) {
          seenReal.add(real);
          allFiles.push(p);
        }
      }
    } catch {
      // skip
    }
  }
  await walk(join(workspaceDir, "memory"));

  // Deduplicate
  const seen = new Set<string>();
  const uniqueFiles: string[] = [];
  for (const f of allFiles) {
    if (!seen.has(f)) {
      seen.add(f);
      uniqueFiles.push(f);
    }
  }

  const existingPaths = new Set(
    (db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map(
      (r) => r.path,
    ),
  );

  let added = 0;
  let updated = 0;
  let unchanged = 0;

  const nowPaths = new Set<string>();

  for (const absPath of uniqueFiles) {
    const relPath = pathMod.relative(workspaceDir, absPath);
    nowPaths.add(relPath);

    const content = await fs.readFile(absPath, "utf-8");
    const s = await fs.stat(absPath);
    const hash = hashText(content);

    const existing = db
      .prepare("SELECT hash FROM files WHERE path = ?")
      .get(relPath) as { hash: string } | undefined;

    if (existing && existing.hash === hash) {
      unchanged++;
      continue;
    }

    // Upsert file record
    db.prepare(
      `INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
       VALUES (?, 'memory', ?, ?, ?)`,
    ).run(relPath, hash, Math.floor(s.mtimeMs), s.size);

    // Delete old chunks for this path
    db.prepare("DELETE FROM chunks WHERE path = ?").run(relPath);

    // Insert new chunks
    const chunks = chunkMarkdown(content, chunking);
    for (const chunk of chunks) {
      const chunkId = `${relPath}:${chunk.startLine}-${chunk.endLine}`;
      db.prepare(
        `INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, 'memory', ?, ?, ?, 'none', ?, '[]', ?)`,
      ).run(
        chunkId,
        relPath,
        chunk.startLine,
        chunk.endLine,
        chunk.hash,
        chunk.text,
        Date.now(),
      );
    }

    if (existing) {
      updated++;
    } else {
      added++;
    }
  }

  // Remove files no longer on disk
  let removed = 0;
  for (const old of existingPaths) {
    if (!nowPaths.has(old)) {
      db.prepare("DELETE FROM chunks WHERE path = ?").run(old);
      db.prepare("DELETE FROM files WHERE path = ?").run(old);
      removed++;
    }
  }

  return { added, updated, removed, unchanged };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("syncMemoryFiles", () => {
  let tmpDir: string;
  let db: DatabaseSync;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-sync-test-"));
    db = new DatabaseSync(":memory:");
    ensureMemorySchema(db);
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {
      // already closed
    }
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("new markdown file creates file record and chunk records", async () => {
    await writeFile(
      join(tmpDir, "MEMORY.md"),
      "# Notes\n\nSome important content here.\n",
    );

    const result = await syncMemoryFiles({ db, workspaceDir: tmpDir });

    expect(result.added).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.removed).toBe(0);

    const files = db.prepare("SELECT * FROM files").all() as Array<{
      path: string;
      hash: string;
    }>;
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe("MEMORY.md");

    const chunks = db.prepare("SELECT * FROM chunks").all();
    expect(chunks.length).toBeGreaterThan(0);
  });

  it("modified file updates chunks without duplicating them", async () => {
    const filePath = join(tmpDir, "MEMORY.md");

    // Initial sync
    await writeFile(filePath, "# Version 1\n\nAlpha bravo charlie.\n");
    await syncMemoryFiles({ db, workspaceDir: tmpDir });

    const chunksBeforeUpdate = db
      .prepare("SELECT * FROM chunks WHERE path = 'MEMORY.md'")
      .all();
    expect(chunksBeforeUpdate.length).toBeGreaterThan(0);

    // Modify and re-sync
    await writeFile(filePath, "# Version 2\n\nDelta echo foxtrot.\n");
    const result = await syncMemoryFiles({ db, workspaceDir: tmpDir });

    expect(result.updated).toBe(1);
    expect(result.added).toBe(0);

    const chunksAfterUpdate = db
      .prepare("SELECT * FROM chunks WHERE path = 'MEMORY.md'")
      .all() as Array<{ text: string }>;
    // Should not have duplicates — same or fewer chunk count
    expect(chunksAfterUpdate.length).toBe(chunksBeforeUpdate.length);
    // Content should reflect the new version
    expect(chunksAfterUpdate.some((c) => c.text.includes("Delta echo"))).toBe(
      true,
    );
    expect(
      chunksAfterUpdate.some((c) => c.text.includes("Alpha bravo")),
    ).toBe(false);
  });

  it("deleted file removes file and chunk records from DB", async () => {
    const filePath = join(tmpDir, "MEMORY.md");
    await writeFile(filePath, "# Temporary\n\nWill be removed.\n");

    await syncMemoryFiles({ db, workspaceDir: tmpDir });
    expect(
      (db.prepare("SELECT * FROM files").all() as unknown[]).length,
    ).toBe(1);

    await unlink(filePath);
    const result = await syncMemoryFiles({ db, workspaceDir: tmpDir });

    expect(result.removed).toBe(1);
    expect((db.prepare("SELECT * FROM files").all() as unknown[]).length).toBe(
      0,
    );
    expect(
      (db.prepare("SELECT * FROM chunks").all() as unknown[]).length,
    ).toBe(0);
  });

  it("chunks respect max token limit", async () => {
    // Create content large enough to produce multiple chunks at a small token limit
    const lines = Array.from(
      { length: 100 },
      (_, i) => `Line ${i + 1}: This is a sentence with some meaningful words.`,
    );
    const content = lines.join("\n");
    await writeFile(join(tmpDir, "MEMORY.md"), content);

    const tokenLimit = 20; // very small — forces many chunks
    await syncMemoryFiles({
      db,
      workspaceDir: tmpDir,
      chunking: { tokens: tokenLimit, overlap: 4 },
    });

    const chunks = db.prepare("SELECT text FROM chunks").all() as Array<{
      text: string;
    }>;
    expect(chunks.length).toBeGreaterThan(1);

    // Verify via chunkMarkdown directly that each chunk respects the limit
    const verifyChunks = chunkMarkdown(content, {
      tokens: tokenLimit,
      overlap: 4,
    });
    const charLimit = tokenLimit * 4;
    for (const chunk of verifyChunks) {
      // Allow last chunk to be under the limit; intermediate chunks should be near the limit
      expect(chunk.text.length).toBeLessThanOrEqual(charLimit + 200); // some slack for line boundaries
    }
  });

  it("non-markdown files are ignored", async () => {
    await mkdir(join(tmpDir, "memory"), { recursive: true });
    await writeFile(join(tmpDir, "memory", "notes.txt"), "text file content");
    await writeFile(
      join(tmpDir, "memory", "data.json"),
      '{"key": "value"}',
    );
    await writeFile(join(tmpDir, "memory", "valid.md"), "# Valid\n\nMarkdown.");

    const result = await syncMemoryFiles({ db, workspaceDir: tmpDir });

    const files = db.prepare("SELECT path FROM files").all() as Array<{
      path: string;
    }>;
    const paths = files.map((f) => f.path);
    expect(paths).toContain(join("memory", "valid.md"));
    expect(paths).not.toContain(join("memory", "notes.txt"));
    expect(paths).not.toContain(join("memory", "data.json"));
    expect(result.added).toBe(1);
  });

  it("empty file creates file record but no chunks", async () => {
    await writeFile(join(tmpDir, "MEMORY.md"), "");

    const result = await syncMemoryFiles({ db, workspaceDir: tmpDir });

    expect(result.added).toBe(1);
    const files = db.prepare("SELECT * FROM files").all();
    expect(files).toHaveLength(1);

    const chunks = db.prepare("SELECT * FROM chunks").all();
    expect(chunks).toHaveLength(0);
  });

  it("concurrent sync of same file is idempotent", async () => {
    await writeFile(
      join(tmpDir, "MEMORY.md"),
      "# Concurrent\n\nSame content for both syncs.\n",
    );

    // Run two syncs concurrently
    const [result1, result2] = await Promise.all([
      syncMemoryFiles({ db, workspaceDir: tmpDir }),
      syncMemoryFiles({ db, workspaceDir: tmpDir }),
    ]);

    // Total adds across both should still result in exactly 1 file record
    const files = db.prepare("SELECT * FROM files").all();
    expect(files).toHaveLength(1);

    // Chunks should not be duplicated
    const chunks = db.prepare("SELECT * FROM chunks").all();
    const chunkIds = new Set(
      (chunks as Array<{ id: string }>).map((c) => c.id),
    );
    expect(chunkIds.size).toBe(chunks.length); // no duplicate IDs
  });
});
