/**
 * Contract: Memory SQLite Schema
 *
 * ensureMemoryIndexSchema(params) creates all tables for the memory index
 * with parameterized table names and conditional FTS.
 *
 * ensureMemorySchema(db) is a backward-compatible wrapper that calls
 * ensureMemoryIndexSchema with default params.
 *
 * Tables: meta, files, chunks, embedding_cache (parameterized), chunks_fts (parameterized)
 *
 * Behavior:
 * - Idempotent — calling twice doesn't error
 * - FTS5 virtual table created conditionally (ftsEnabled param)
 * - Returns { ftsAvailable: boolean, ftsError?: string }
 * - ensureColumn() migrates missing columns for backward compat
 * - Indexes created on chunks(path), chunks(source), embedding_cache(updated_at)
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
  ensureMemorySchema,
  ensureMemoryIndexSchema,
  FTS_TABLE,
  EMBEDDING_CACHE_TABLE,
} from "./schema.js";

function createTestDb(): DatabaseSync {
  return new DatabaseSync(":memory:");
}

function getTableNames(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

describe("ensureMemoryIndexSchema", () => {
  it("creates all required tables with parameterized names", () => {
    const db = createTestDb();
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "my_embed_cache",
      ftsTable: "my_fts",
      ftsEnabled: true,
    });

    const tables = getTableNames(db);
    expect(tables).toContain("meta");
    expect(tables).toContain("files");
    expect(tables).toContain("chunks");
    expect(tables).toContain("my_embed_cache");
  });

  it("creates FTS table with custom name when enabled", () => {
    const db = createTestDb();
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embed_cache",
      ftsTable: "custom_fts",
      ftsEnabled: true,
    });

    if (result.ftsAvailable) {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all("custom_fts") as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe("custom_fts");
    } else {
      expect(result.ftsError).toBeDefined();
    }
  });

  it("skips FTS creation when ftsEnabled is false", () => {
    const db = createTestDb();
    const result = ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });

    expect(result.ftsAvailable).toBe(false);
    expect(result.ftsError).toBeUndefined();

    const tables = getTableNames(db);
    expect(tables).not.toContain("chunks_fts");
  });

  it("is idempotent — can run twice without error", () => {
    const db = createTestDb();
    const params = {
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: true,
    };
    const first = ensureMemoryIndexSchema(params);
    const second = ensureMemoryIndexSchema(params);

    expect(first.ftsAvailable).toBe(second.ftsAvailable);

    const tables = getTableNames(db);
    expect(tables).toContain("meta");
    expect(tables).toContain("chunks");
  });

  it("ensureColumn migrates missing columns on existing tables", () => {
    const db = createTestDb();

    // Create tables without the 'source' column to simulate old schema
    db.exec(`
      CREATE TABLE files (
        path TEXT PRIMARY KEY,
        hash TEXT NOT NULL,
        mtime INTEGER NOT NULL,
        size INTEGER NOT NULL
      );
    `);
    db.exec(`
      CREATE TABLE chunks (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL,
        start_line INTEGER NOT NULL,
        end_line INTEGER NOT NULL,
        hash TEXT NOT NULL,
        model TEXT NOT NULL,
        text TEXT NOT NULL,
        embedding TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    // ensureMemoryIndexSchema should add the missing 'source' column via ensureColumn
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });

    // Verify 'source' column now exists on both tables
    const filesCols = db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
    expect(filesCols.some((c) => c.name === "source")).toBe(true);

    const chunksCols = db.prepare("PRAGMA table_info(chunks)").all() as Array<{ name: string }>;
    expect(chunksCols.some((c) => c.name === "source")).toBe(true);
  });

  it("can insert and query chunks", () => {
    const db = createTestDb();
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });

    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("chunk-1", "notes/test.md", "memory", 1, 10, "abc123", "fts-only", "Hello world", "[]", Date.now());

    const rows = db
      .prepare("SELECT * FROM chunks WHERE id = ?")
      .all("chunk-1") as Array<{ id: string; path: string; text: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("chunk-1");
    expect(rows[0]!.path).toBe("notes/test.md");
    expect(rows[0]!.text).toBe("Hello world");
  });

  it("creates indexes on chunks and embedding_cache", () => {
    const db = createTestDb();
    ensureMemoryIndexSchema({
      db,
      embeddingCacheTable: "embedding_cache",
      ftsTable: "chunks_fts",
      ftsEnabled: false,
    });

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_chunks_path");
    expect(indexNames).toContain("idx_chunks_source");
    expect(indexNames).toContain("idx_embedding_cache_updated_at");
  });
});

describe("ensureMemorySchema (backward-compat wrapper)", () => {
  it("creates all required tables with default names", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    const tables = getTableNames(db);
    expect(tables).toContain("meta");
    expect(tables).toContain("files");
    expect(tables).toContain("chunks");
    expect(tables).toContain("embedding_cache");
  });

  it("creates FTS5 virtual table", () => {
    const db = createTestDb();
    const result = ensureMemorySchema(db);

    if (result.ftsAvailable) {
      const rows = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .all(FTS_TABLE) as Array<{ name: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.name).toBe(FTS_TABLE);
    } else {
      expect(result.ftsError).toBeDefined();
    }
  });

  it("is idempotent — can run twice without error", () => {
    const db = createTestDb();
    const first = ensureMemorySchema(db);
    const second = ensureMemorySchema(db);

    expect(first.ftsAvailable).toBe(second.ftsAvailable);
  });

  it("can insert and query files table", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`,
    ).run("MEMORY.md", "memory", "sha256hash", Date.now(), 1024);

    const rows = db
      .prepare("SELECT * FROM files WHERE path = ?")
      .all("MEMORY.md") as Array<{ path: string; source: string; hash: string; size: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.source).toBe("memory");
    expect(rows[0]!.size).toBe(1024);
  });

  it("can insert and query embedding_cache table", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    db.prepare(
      `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("openai", "text-embedding-3-small", "key1", "hash1", "[0.1, 0.2]", 2, Date.now());

    const rows = db
      .prepare(`SELECT * FROM ${EMBEDDING_CACHE_TABLE} WHERE provider = ?`)
      .all("openai") as Array<{ provider: string; model: string; embedding: string; dims: number }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.model).toBe("text-embedding-3-small");
    expect(rows[0]!.dims).toBe(2);
  });

  it("can insert and query meta table", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "last_sync",
      String(Date.now()),
    );

    const rows = db
      .prepare("SELECT * FROM meta WHERE key = ?")
      .all("last_sync") as Array<{ key: string; value: string }>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toBe("last_sync");
  });

  it("FTS5 search returns matching chunks when available", () => {
    const db = createTestDb();
    const result = ensureMemorySchema(db);

    if (!result.ftsAvailable) return;

    db.prepare(
      `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("quantum entanglement physics", "c1", "notes.md", "memory", "fts-only", "1", "5");

    db.prepare(
      `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run("cooking recipes pasta italian", "c2", "food.md", "memory", "fts-only", "1", "3");

    const rows = db
      .prepare(`SELECT id, path, rank FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank`)
      .all('"quantum"') as Array<{ id: string; path: string; rank: number }>;

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.id).toBe("c1");
    expect(rows[0]!.path).toBe("notes.md");
  });

  it("deleting a file's chunks can be done by path", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    db.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`,
    ).run("old.md", "memory", "oldhash", Date.now(), 100);

    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "old.md", "memory", 1, 5, "h1", "fts-only", "chunk text", "[]", Date.now());

    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c2", "old.md", "memory", 6, 10, "h2", "fts-only", "more text", "[]", Date.now());

    db.prepare("DELETE FROM chunks WHERE path = ?").run("old.md");
    db.prepare("DELETE FROM files WHERE path = ?").run("old.md");

    const chunks = db.prepare("SELECT * FROM chunks WHERE path = ?").all("old.md");
    const files = db.prepare("SELECT * FROM files WHERE path = ?").all("old.md");

    expect(chunks).toHaveLength(0);
    expect(files).toHaveLength(0);
  });

  it("creates indexes on chunks and embedding_cache", () => {
    const db = createTestDb();
    ensureMemorySchema(db);

    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
      .all() as Array<{ name: string }>;

    const indexNames = indexes.map((i) => i.name);
    expect(indexNames).toContain("idx_chunks_path");
    expect(indexNames).toContain("idx_chunks_source");
    expect(indexNames).toContain("idx_embedding_cache_updated_at");
  });
});
