import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs/promises";
import { ensureMemorySchema, FTS_TABLE } from "./schema.js";
import {
  hashText,
  chunkMarkdown,
  listMemoryFiles,
  buildFileEntry,
} from "./internal.js";
import {
  buildFtsQuery,
  bm25RankToScore,
  extractKeywords,
} from "./query-expansion.js";
import { mergeHybridResults } from "./hybrid.js";
import type {
  MemorySearchResult,
  MemoryProviderStatus,
  MemorySyncProgress,
} from "./types.js";
import type { TemporalDecayConfig } from "./temporal-decay.js";
import type { MMRConfig } from "./mmr.js";

export interface MemoryManagerConfig {
  dbPath: string;
  workspaceDir: string;
  chunkTokens?: number;
  chunkOverlap?: number;
  vectorWeight?: number;
  textWeight?: number;
  mmr?: Partial<MMRConfig>;
  temporalDecay?: Partial<TemporalDecayConfig>;
}

export interface MemoryManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]>;
  sync(opts?: {
    force?: boolean;
    progress?: (update: MemorySyncProgress) => void;
  }): Promise<void>;
  readFile(
    relPath: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  close(): void;
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const {
    dbPath,
    workspaceDir,
    chunkTokens = 400,
    chunkOverlap = 80,
    vectorWeight = 0.7,
    textWeight = 0.3,
    mmr,
    temporalDecay,
  } = config;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  const { ftsAvailable } = ensureMemorySchema(db);
  let dirty = true;

  async function search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? 6;
    const minScore = opts?.minScore ?? 0;

    if (!ftsAvailable) return [];

    const keywords = extractKeywords(query);
    const ftsQueries = new Set<string>();

    const mainFts = buildFtsQuery(query);
    if (mainFts) ftsQueries.add(mainFts);

    for (const kw of keywords) {
      const kwFts = buildFtsQuery(kw);
      if (kwFts) ftsQueries.add(kwFts);
    }

    if (ftsQueries.size === 0) return [];

    const seen = new Map<string, { id: string; path: string; startLine: number; endLine: number; source: string; snippet: string; textScore: number }>();
    const limit = maxResults * 4;

    for (const ftsQuery of ftsQueries) {
      const rows = db
        .prepare(
          `SELECT id, path, source, start_line, end_line, text, rank
           FROM ${FTS_TABLE}
           WHERE text MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as Array<{
        id: string;
        path: string;
        source: string;
        start_line: number;
        end_line: number;
        text: string;
        rank: number;
      }>;

      for (const row of rows) {
        const score = bm25RankToScore(row.rank);
        const existing = seen.get(row.id);
        if (!existing || score > existing.textScore) {
          seen.set(row.id, {
            id: row.id,
            path: row.path,
            startLine: row.start_line,
            endLine: row.end_line,
            source: row.source,
            snippet: row.text,
            textScore: score,
          });
        }
      }
    }

    const keywordResults = Array.from(seen.values());

    const merged = await mergeHybridResults({
      vector: [],
      keyword: keywordResults,
      vectorWeight: 0,
      textWeight: 1,
      workspaceDir,
      mmr,
      temporalDecay,
    });

    return merged
      .filter((r) => r.score >= minScore)
      .slice(0, maxResults)
      .map((r) => ({
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        score: r.score,
        snippet: r.snippet,
        source: r.source as "memory" | "sessions",
        citation: `${r.path}#L${r.startLine}-L${r.endLine}`,
      }));
  }

  async function sync(opts?: {
    force?: boolean;
    progress?: (update: MemorySyncProgress) => void;
  }): Promise<void> {
    const force = opts?.force ?? false;
    const progress = opts?.progress;

    const filePaths = await listMemoryFiles(workspaceDir);
    const total = filePaths.length;
    let completed = 0;

    const indexedPaths = new Set<string>();

    for (const absPath of filePaths) {
      const entry = await buildFileEntry(absPath, workspaceDir);
      if (!entry) {
        completed++;
        if (progress) progress({ completed, total, label: absPath });
        continue;
      }

      indexedPaths.add(entry.path);

      // Check if unchanged
      if (!force) {
        const existing = db
          .prepare("SELECT hash FROM files WHERE path = ?")
          .all(entry.path) as Array<{ hash: string }>;
        if (existing.length > 0 && existing[0].hash === entry.hash) {
          completed++;
          if (progress) progress({ completed, total, label: entry.path });
          continue;
        }
      }

      const content = await fs.readFile(absPath, "utf-8");
      const chunks = chunkMarkdown(content, {
        tokens: chunkTokens,
        overlap: chunkOverlap,
      });

      // Delete old chunks + FTS entries for this path
      if (ftsAvailable) {
        db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(entry.path);
      }
      db.prepare("DELETE FROM chunks WHERE path = ?").run(entry.path);

      // Insert new chunks
      const now = Date.now();
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        const chunkId = `${entry.path}:${i}`;

        db.prepare(
          `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          chunkId,
          entry.path,
          "memory",
          chunk.startLine,
          chunk.endLine,
          chunk.hash,
          "fts-only",
          chunk.text,
          "[]",
          now,
        );

        if (ftsAvailable) {
          db.prepare(
            `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            chunk.text,
            chunkId,
            entry.path,
            "memory",
            "fts-only",
            chunk.startLine,
            chunk.endLine,
          );
        }
      }

      // Upsert file record
      db.prepare(
        `INSERT INTO files (path, source, hash, mtime, size)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path) DO UPDATE SET
           hash = excluded.hash,
           mtime = excluded.mtime,
           size = excluded.size`,
      ).run(entry.path, "memory", entry.hash, Math.floor(entry.mtimeMs), entry.size);

      completed++;
      if (progress) progress({ completed, total, label: entry.path });
    }

    // Remove orphaned files (in DB but not on disk)
    const dbFiles = db
      .prepare("SELECT path FROM files")
      .all() as Array<{ path: string }>;

    for (const row of dbFiles) {
      if (!indexedPaths.has(row.path)) {
        if (ftsAvailable) {
          db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(row.path);
        }
        db.prepare("DELETE FROM chunks WHERE path = ?").run(row.path);
        db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
      }
    }

    dirty = false;
  }

  async function readFile(
    relPath: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string; path: string }> {
    const resolved = path.resolve(workspaceDir, relPath);
    const normalizedWorkspace = path.resolve(workspaceDir);

    if (!resolved.startsWith(normalizedWorkspace + path.sep) && resolved !== normalizedWorkspace) {
      throw new Error(`Path traversal detected: ${relPath}`);
    }

    const content = await fs.readFile(resolved, "utf-8");
    const allLines = content.split("\n");

    if (from !== undefined) {
      const startIdx = Math.max(0, from - 1); // 1-indexed
      const endIdx =
        lines !== undefined ? startIdx + lines : allLines.length;
      const sliced = allLines.slice(startIdx, endIdx).join("\n");
      return { text: sliced, path: resolved };
    }

    return { text: content, path: resolved };
  }

  function status(): MemoryProviderStatus {
    const fileCount = (
      db.prepare("SELECT COUNT(*) as count FROM files").all() as Array<{
        count: number;
      }>
    )[0].count;

    const chunkCount = (
      db.prepare("SELECT COUNT(*) as count FROM chunks").all() as Array<{
        count: number;
      }>
    )[0].count;

    const cacheCount = ftsAvailable
      ? 0
      : 0;

    return {
      provider: "fts-only",
      files: fileCount,
      chunks: chunkCount,
      dirty,
      dbPath,
      fts: { enabled: true, available: ftsAvailable },
      vector: { enabled: false },
      cache: { enabled: false, entries: cacheCount },
    };
  }

  function close(): void {
    db.close();
  }

  return { search, sync, readFile, status, close };
}
