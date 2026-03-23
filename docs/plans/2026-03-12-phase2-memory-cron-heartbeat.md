# Phase 2: Memory, Cron, and Heartbeat Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add persistent memory (SQLite FTS5 + sqlite-vec), cron scheduling, heartbeat runner, and proactive messaging to OpenClaude.

**Architecture:** Memory uses a two-layer design — markdown files as source of truth, SQLite FTS5 + sqlite-vec as search index. Cron uses Croner for schedule computation with JSON file persistence. Heartbeat reads a checklist file and runs isolated Claude sessions. All three systems wire into the gateway lifecycle.

**Tech Stack:** better-sqlite3, sqlite-vec, Croner v10, chokidar (optional), Node.js crypto for hashing

---

### Task 1: Memory Types and Schema

**Files:**
- Create: `src/memory/types.ts`
- Create: `src/memory/schema.ts`
- Test: `src/memory/schema.test.ts`

**Step 1: Create memory types**

```typescript
// src/memory/types.ts
export type MemorySource = "memory" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
};

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
};

export type MemorySyncProgress = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  provider: string;
  model?: string;
  files: number;
  chunks: number;
  dirty: boolean;
  dbPath: string;
  fts: { enabled: boolean; available: boolean; error?: string };
  vector: { enabled: boolean; available?: boolean; dims?: number; loadError?: string };
  cache: { enabled: boolean; entries: number };
};
```

**Step 2: Create memory schema (extracted from OpenClaw memory-schema.ts)**

```typescript
// src/memory/schema.ts
import type { DatabaseSync } from "node:sqlite";

const EMBEDDING_CACHE_TABLE = "embedding_cache";
const FTS_TABLE = "chunks_fts";
const VECTOR_TABLE = "chunks_vec";

export function ensureMemorySchema(db: DatabaseSync): {
  ftsAvailable: boolean;
  ftsError?: string;
  vectorAvailable: boolean;
  vectorError?: string;
} {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'memory',
      hash TEXT NOT NULL,
      mtime INTEGER NOT NULL,
      size INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'memory',
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      hash TEXT NOT NULL,
      model TEXT NOT NULL,
      text TEXT NOT NULL,
      embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS ${EMBEDDING_CACHE_TABLE} (
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      provider_key TEXT NOT NULL,
      hash TEXT NOT NULL,
      embedding TEXT NOT NULL,
      dims INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (provider, model, provider_key, hash)
    );
  `);

  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_embedding_cache_updated_at ON ${EMBEDDING_CACHE_TABLE}(updated_at);`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path ON chunks(path);`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);`);

  // Ensure backward-compatible columns
  ensureColumn(db, "files", "source", "TEXT NOT NULL DEFAULT 'memory'");
  ensureColumn(db, "chunks", "source", "TEXT NOT NULL DEFAULT 'memory'");

  // FTS5
  let ftsAvailable = false;
  let ftsError: string | undefined;
  try {
    db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(\n` +
        `  text,\n` +
        `  id UNINDEXED,\n` +
        `  path UNINDEXED,\n` +
        `  source UNINDEXED,\n` +
        `  model UNINDEXED,\n` +
        `  start_line UNINDEXED,\n` +
        `  end_line UNINDEXED\n` +
        `);`,
    );
    ftsAvailable = true;
  } catch (err) {
    ftsError = err instanceof Error ? err.message : String(err);
  }

  // sqlite-vec
  let vectorAvailable = false;
  let vectorError: string | undefined;
  try {
    // Try loading sqlite-vec extension
    const sqliteVec = await_import_sqlite_vec();
    if (sqliteVec) {
      db.enableLoadExtension(true);
      sqliteVec.load(db);
      vectorAvailable = true;
    }
  } catch (err) {
    vectorError = err instanceof Error ? err.message : String(err);
  }

  return {
    ftsAvailable,
    ...(ftsError ? { ftsError } : {}),
    vectorAvailable,
    ...(vectorError ? { vectorError } : {}),
  };
}

function ensureColumn(
  db: DatabaseSync,
  table: string,
  column: string,
  definition: string,
): void {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function await_import_sqlite_vec(): { load: (db: DatabaseSync) => void; getLoadablePath: () => string } | null {
  try {
    // Dynamic require for sqlite-vec — may not be installed
    const mod = require("sqlite-vec");
    return mod;
  } catch {
    return null;
  }
}

export { EMBEDDING_CACHE_TABLE, FTS_TABLE, VECTOR_TABLE };
```

**Step 3: Write schema test**

```typescript
// src/memory/schema.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { ensureMemorySchema } from "./schema.js";

describe("ensureMemorySchema", () => {
  let db: DatabaseSync;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("creates all required tables", () => {
    ensureMemorySchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("meta");
    expect(names).toContain("files");
    expect(names).toContain("chunks");
    expect(names).toContain("embedding_cache");
  });

  it("creates FTS5 virtual table", () => {
    const result = ensureMemorySchema(db);
    expect(result.ftsAvailable).toBe(true);
  });

  it("is idempotent", () => {
    ensureMemorySchema(db);
    const result = ensureMemorySchema(db);
    expect(result.ftsAvailable).toBe(true);
  });

  it("can insert and query chunks", () => {
    ensureMemorySchema(db);
    db.prepare(
      `INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("c1", "MEMORY.md", "memory", 1, 10, "abc", "fts-only", "hello world", "[]", Date.now());
    const rows = db.prepare("SELECT * FROM chunks WHERE id = ?").all("c1");
    expect(rows).toHaveLength(1);
  });
});
```

**Step 4: Run tests**

Run: `pnpm test src/memory/schema.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/types.ts src/memory/schema.ts src/memory/schema.test.ts
git commit -m "feat(memory): add types and SQLite schema"
```

---

### Task 2: Markdown Chunking and Utilities

**Files:**
- Create: `src/memory/internal.ts`
- Test: `src/memory/internal.test.ts`

**Step 1: Create internal utilities (extracted from OpenClaw internal.ts)**

Core functions needed: `hashText`, `chunkMarkdown`, `listMemoryFiles`, `buildFileEntry`, `parseEmbedding`, `cosineSimilarity`.

Strip multimodal support, `runWithConcurrency` helper, and external dependencies (`detectMime`, `runTasksWithConcurrency`).

```typescript
// src/memory/internal.ts
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MemoryChunk, MemoryFileEntry } from "./types.js";

export function hashText(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function chunkMarkdown(
  content: string,
  chunking: { tokens: number; overlap: number },
): MemoryChunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) return [];

  const maxChars = Math.max(32, chunking.tokens * 4);
  const overlapChars = Math.max(0, chunking.overlap * 4);
  const chunks: MemoryChunk[] = [];

  let current: Array<{ line: string; lineNo: number }> = [];
  let currentChars = 0;

  const flush = () => {
    if (current.length === 0) return;
    const firstEntry = current[0]!;
    const lastEntry = current[current.length - 1]!;
    const text = current.map((e) => e.line).join("\n");
    chunks.push({
      startLine: firstEntry.lineNo,
      endLine: lastEntry.lineNo,
      text,
      hash: hashText(text),
    });
  };

  const carryOverlap = () => {
    if (overlapChars <= 0 || current.length === 0) {
      current = [];
      currentChars = 0;
      return;
    }
    let acc = 0;
    const kept: Array<{ line: string; lineNo: number }> = [];
    for (let i = current.length - 1; i >= 0; i--) {
      const entry = current[i]!;
      acc += entry.line.length + 1;
      kept.unshift(entry);
      if (acc >= overlapChars) break;
    }
    current = kept;
    currentChars = kept.reduce((sum, e) => sum + e.line.length + 1, 0);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const lineNo = i + 1;
    const lineSize = line.length + 1;

    if (currentChars + lineSize > maxChars && current.length > 0) {
      flush();
      carryOverlap();
    }
    current.push({ line, lineNo });
    currentChars += lineSize;
  }
  flush();
  return chunks;
}

export async function listMemoryFiles(workspaceDir: string): Promise<string[]> {
  const result: string[] = [];
  const memoryFile = path.join(workspaceDir, "MEMORY.md");
  const altMemoryFile = path.join(workspaceDir, "memory.md");
  const memoryDir = path.join(workspaceDir, "memory");

  for (const filePath of [memoryFile, altMemoryFile]) {
    try {
      const stat = await fs.lstat(filePath);
      if (stat.isFile() && !stat.isSymbolicLink()) {
        result.push(filePath);
      }
    } catch { /* not found */ }
  }

  try {
    const dirStat = await fs.lstat(memoryDir);
    if (dirStat.isDirectory() && !dirStat.isSymbolicLink()) {
      await walkDir(memoryDir, result);
    }
  } catch { /* not found */ }

  // Deduplicate by realpath
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const entry of result) {
    let key = entry;
    try { key = await fs.realpath(entry); } catch { /* use original */ }
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(entry);
    }
  }
  return deduped;
}

async function walkDir(dir: string, files: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      await walkDir(full, files);
      continue;
    }
    if (entry.isFile() && full.endsWith(".md")) {
      files.push(full);
    }
  }
}

export async function buildFileEntry(
  absPath: string,
  workspaceDir: string,
): Promise<MemoryFileEntry | null> {
  let stat;
  try {
    stat = await fs.stat(absPath);
  } catch {
    return null;
  }
  let content: string;
  try {
    content = await fs.readFile(absPath, "utf-8");
  } catch {
    return null;
  }
  return {
    path: path.relative(workspaceDir, absPath).replace(/\\/g, "/"),
    absPath,
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    hash: hashText(content),
  };
}

export function parseEmbedding(raw: string): number[] {
  try {
    const parsed = JSON.parse(raw) as number[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < len; i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function isMemoryPath(relPath: string): boolean {
  const normalized = relPath.trim().replace(/^[./]+/, "").replace(/\\/g, "/");
  if (!normalized) return false;
  if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
  return normalized.startsWith("memory/");
}
```

**Step 2: Write tests**

```typescript
// src/memory/internal.test.ts
import { describe, it, expect } from "vitest";
import { hashText, chunkMarkdown, parseEmbedding, cosineSimilarity, isMemoryPath } from "./internal.js";

describe("hashText", () => {
  it("returns consistent SHA-256 hex", () => {
    const h1 = hashText("hello");
    const h2 = hashText("hello");
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(64);
  });

  it("different text produces different hash", () => {
    expect(hashText("a")).not.toBe(hashText("b"));
  });
});

describe("chunkMarkdown", () => {
  it("returns empty array for empty content", () => {
    expect(chunkMarkdown("", { tokens: 400, overlap: 80 })).toEqual([]);
  });

  it("creates single chunk for short content", () => {
    const chunks = chunkMarkdown("line 1\nline 2", { tokens: 400, overlap: 80 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[0]!.endLine).toBe(2);
  });

  it("splits long content into multiple chunks", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}: ${"x".repeat(20)}`);
    const content = lines.join("\n");
    const chunks = chunkMarkdown(content, { tokens: 100, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);
    // Verify chunks cover all lines
    expect(chunks[0]!.startLine).toBe(1);
    expect(chunks[chunks.length - 1]!.endLine).toBe(200);
  });

  it("includes overlap between chunks", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}: ${"a".repeat(50)}`);
    const chunks = chunkMarkdown(lines.join("\n"), { tokens: 50, overlap: 10 });
    if (chunks.length >= 2) {
      // Second chunk should start before the first chunk ends (overlap)
      expect(chunks[1]!.startLine).toBeLessThanOrEqual(chunks[0]!.endLine);
    }
  });

  it("each chunk has a hash", () => {
    const chunks = chunkMarkdown("hello\nworld", { tokens: 400, overlap: 0 });
    expect(chunks[0]!.hash).toHaveLength(64);
  });
});

describe("parseEmbedding", () => {
  it("parses JSON array", () => {
    expect(parseEmbedding("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("returns empty for invalid JSON", () => {
    expect(parseEmbedding("invalid")).toEqual([]);
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
  });

  it("returns 0 for orthogonal vectors", () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for empty vectors", () => {
    expect(cosineSimilarity([], [1, 2])).toBe(0);
  });
});

describe("isMemoryPath", () => {
  it("recognizes MEMORY.md", () => {
    expect(isMemoryPath("MEMORY.md")).toBe(true);
    expect(isMemoryPath("./MEMORY.md")).toBe(true);
  });

  it("recognizes memory/ subdirectory", () => {
    expect(isMemoryPath("memory/2026-01-01.md")).toBe(true);
  });

  it("rejects other paths", () => {
    expect(isMemoryPath("src/index.ts")).toBe(false);
    expect(isMemoryPath("")).toBe(false);
  });
});
```

**Step 3: Run tests**

Run: `pnpm test src/memory/internal.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/internal.ts src/memory/internal.test.ts
git commit -m "feat(memory): add markdown chunking and file utilities"
```

---

### Task 3: Hybrid Search (FTS + Vector Merge, Temporal Decay, MMR)

**Files:**
- Create: `src/memory/query-expansion.ts`
- Create: `src/memory/hybrid.ts`
- Create: `src/memory/temporal-decay.ts`
- Create: `src/memory/mmr.ts`
- Test: `src/memory/hybrid.test.ts`
- Test: `src/memory/mmr.test.ts`

**Step 1: Create query expansion (extracted from OpenClaw)**

Extract `extractKeywords`, `expandQueryForFts`, `buildFtsQuery`, `bm25RankToScore` — keep English stop words, strip the multilingual stop words to reduce size (they can be added later).

```typescript
// src/memory/query-expansion.ts
// Extracted from OpenClaw's query-expansion.ts — English stop words only for v1

const STOP_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your", "he", "she", "it", "they", "them",
  "is", "are", "was", "were", "be", "been", "being", "have", "has", "had",
  "do", "does", "did", "will", "would", "could", "should", "can", "may", "might",
  "in", "on", "at", "to", "for", "of", "with", "by", "from", "about", "into",
  "through", "during", "before", "after", "above", "below", "between", "under", "over",
  "and", "or", "but", "if", "then", "because", "as", "while", "when", "where",
  "what", "which", "who", "how", "why",
  "yesterday", "today", "tomorrow", "earlier", "later", "recently", "ago", "just", "now",
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  "please", "help", "find", "show", "get", "tell", "give",
]);

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token);
}

function isValidKeyword(token: string): boolean {
  if (!token || token.length === 0) return false;
  if (/^[a-zA-Z]+$/.test(token) && token.length < 3) return false;
  if (/^\d+$/.test(token)) return false;
  if (/^[\p{P}\p{S}]+$/u.test(token)) return false;
  return true;
}

export function extractKeywords(query: string): string[] {
  const tokens = query.toLowerCase().trim().split(/[\s\p{P}]+/u).filter(Boolean);
  const keywords: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    if (isStopWord(token) || !isValidKeyword(token) || seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }
  return keywords;
}

export function buildFtsQuery(raw: string): string | null {
  const tokens = raw.match(/[\p{L}\p{N}_]+/gu)?.map((t) => t.trim()).filter(Boolean) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replaceAll('"', "")}"`).join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (!Number.isFinite(rank)) return 1 / (1 + 999);
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
```

**Step 2: Create temporal decay (extracted from OpenClaw)**

```typescript
// src/memory/temporal-decay.ts
import fs from "node:fs/promises";
import path from "node:path";

export type TemporalDecayConfig = {
  enabled: boolean;
  halfLifeDays: number;
};

export const DEFAULT_TEMPORAL_DECAY_CONFIG: TemporalDecayConfig = {
  enabled: false,
  halfLifeDays: 30,
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DATED_MEMORY_PATH_RE = /(?:^|\/)memory\/(\d{4})-(\d{2})-(\d{2})\.md$/;

export function calculateTemporalDecayMultiplier(params: {
  ageInDays: number;
  halfLifeDays: number;
}): number {
  const lambda = Math.LN2 / Math.max(params.halfLifeDays, 0.001);
  const age = Math.max(0, params.ageInDays);
  return Math.exp(-lambda * age);
}

function parseMemoryDateFromPath(filePath: string): Date | null {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  const match = DATED_MEMORY_PATH_RE.exec(normalized);
  if (!match) return null;
  const [, y, m, d] = match;
  const timestamp = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const parsed = new Date(timestamp);
  if (parsed.getUTCFullYear() !== Number(y) || parsed.getUTCMonth() !== Number(m) - 1 || parsed.getUTCDate() !== Number(d)) {
    return null;
  }
  return parsed;
}

function isEvergreenMemoryPath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized === "MEMORY.md" || normalized === "memory.md") return true;
  if (!normalized.startsWith("memory/")) return false;
  return !DATED_MEMORY_PATH_RE.test(normalized);
}

async function extractTimestamp(filePath: string, source: string, workspaceDir?: string): Promise<Date | null> {
  const fromPath = parseMemoryDateFromPath(filePath);
  if (fromPath) return fromPath;
  if (source === "memory" && isEvergreenMemoryPath(filePath)) return null;
  if (!workspaceDir) return null;
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(workspaceDir, filePath);
  try {
    const stat = await fs.stat(abs);
    return Number.isFinite(stat.mtimeMs) ? new Date(stat.mtimeMs) : null;
  } catch {
    return null;
  }
}

export async function applyTemporalDecay<T extends { path: string; score: number; source: string }>(
  results: T[],
  config: TemporalDecayConfig,
  workspaceDir?: string,
  nowMs?: number,
): Promise<T[]> {
  if (!config.enabled) return [...results];
  const now = nowMs ?? Date.now();
  const cache = new Map<string, Promise<Date | null>>();

  return Promise.all(
    results.map(async (entry) => {
      const key = `${entry.source}:${entry.path}`;
      let promise = cache.get(key);
      if (!promise) {
        promise = extractTimestamp(entry.path, entry.source, workspaceDir);
        cache.set(key, promise);
      }
      const timestamp = await promise;
      if (!timestamp) return entry;
      const ageInDays = Math.max(0, now - timestamp.getTime()) / DAY_MS;
      const multiplier = calculateTemporalDecayMultiplier({ ageInDays, halfLifeDays: config.halfLifeDays });
      return { ...entry, score: entry.score * multiplier };
    }),
  );
}
```

**Step 3: Create MMR (extracted from OpenClaw)**

```typescript
// src/memory/mmr.ts
export type MMRConfig = {
  enabled: boolean;
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

export function tokenize(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(tokens);
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersectionSize = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;
  for (const token of smaller) {
    if (larger.has(token)) intersectionSize++;
  }
  const unionSize = setA.size + setB.size - intersectionSize;
  return unionSize === 0 ? 0 : intersectionSize / unionSize;
}

export function applyMMR<T extends { score: number; snippet: string; path: string; startLine: number }>(
  results: T[],
  config: Partial<MMRConfig> = {},
): T[] {
  const { enabled = false, lambda = 0.7 } = config;
  if (!enabled || results.length <= 1) return [...results];
  const clampedLambda = Math.max(0, Math.min(1, lambda));
  if (clampedLambda === 1) return [...results].sort((a, b) => b.score - a.score);

  const tokenCache = new Map<string, Set<string>>();
  const getId = (r: T, i: number) => `${r.path}:${r.startLine}:${i}`;
  for (let i = 0; i < results.length; i++) {
    tokenCache.set(getId(results[i]!, i), tokenize(results[i]!.snippet));
  }

  const maxScore = Math.max(...results.map((r) => r.score));
  const minScore = Math.min(...results.map((r) => r.score));
  const range = maxScore - minScore;
  const normalize = (s: number) => (range === 0 ? 1 : (s - minScore) / range);

  const selected: T[] = [];
  const remaining = new Set(results.map((_, i) => i));

  while (remaining.size > 0) {
    let bestIdx = -1;
    let bestMMR = -Infinity;

    for (const idx of remaining) {
      const candidate = results[idx]!;
      const candidateTokens = tokenCache.get(getId(candidate, idx))!;
      let maxSim = 0;
      for (let si = 0; si < selected.length; si++) {
        const selTokens = tokenCache.get(getId(selected[si]!, si))!;
        const sim = jaccardSimilarity(candidateTokens, selTokens);
        if (sim > maxSim) maxSim = sim;
      }
      const mmr = clampedLambda * normalize(candidate.score) - (1 - clampedLambda) * maxSim;
      if (mmr > bestMMR || (mmr === bestMMR && candidate.score > (results[bestIdx]?.score ?? -Infinity))) {
        bestMMR = mmr;
        bestIdx = idx;
      }
    }

    if (bestIdx >= 0) {
      selected.push(results[bestIdx]!);
      remaining.delete(bestIdx);
    } else break;
  }

  return selected;
}
```

**Step 4: Create hybrid merge (extracted from OpenClaw)**

```typescript
// src/memory/hybrid.ts
import { applyMMR, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import { applyTemporalDecay, type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG } from "./temporal-decay.js";

export { type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
export { type TemporalDecayConfig, DEFAULT_TEMPORAL_DECAY_CONFIG } from "./temporal-decay.js";

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  textScore: number;
};

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  mmr?: Partial<MMRConfig>;
  temporalDecay?: Partial<TemporalDecayConfig>;
  nowMs?: number;
}): Promise<Array<{
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: string;
}>> {
  const byId = new Map<string, {
    id: string; path: string; startLine: number; endLine: number;
    source: string; snippet: string; vectorScore: number; textScore: number;
  }>();

  for (const r of params.vector) {
    byId.set(r.id, { ...r, vectorScore: r.vectorScore, textScore: 0 });
  }
  for (const r of params.keyword) {
    const existing = byId.get(r.id);
    if (existing) {
      existing.textScore = r.textScore;
      if (r.snippet) existing.snippet = r.snippet;
    } else {
      byId.set(r.id, { id: r.id, path: r.path, startLine: r.startLine, endLine: r.endLine, source: r.source, snippet: r.snippet, vectorScore: 0, textScore: r.textScore });
    }
  }

  const merged = Array.from(byId.values()).map((e) => ({
    path: e.path, startLine: e.startLine, endLine: e.endLine,
    score: params.vectorWeight * e.vectorScore + params.textWeight * e.textScore,
    snippet: e.snippet, source: e.source,
  }));

  const decayConfig = { ...DEFAULT_TEMPORAL_DECAY_CONFIG, ...params.temporalDecay };
  const decayed = await applyTemporalDecay(merged, decayConfig, params.workspaceDir, params.nowMs);
  const sorted = decayed.sort((a, b) => b.score - a.score);

  const mmrConfig = { ...DEFAULT_MMR_CONFIG, ...params.mmr };
  if (mmrConfig.enabled) return applyMMR(sorted, mmrConfig);
  return sorted;
}
```

**Step 5: Write tests**

```typescript
// src/memory/hybrid.test.ts
import { describe, it, expect } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { bm25RankToScore, buildFtsQuery, extractKeywords } from "./query-expansion.js";

describe("mergeHybridResults", () => {
  it("merges vector and keyword results", async () => {
    const results = await mergeHybridResults({
      vector: [{ id: "1", path: "a.md", startLine: 1, endLine: 5, source: "memory", snippet: "hello", vectorScore: 0.9 }],
      keyword: [{ id: "1", path: "a.md", startLine: 1, endLine: 5, source: "memory", snippet: "hello", textScore: 0.8 }],
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBeCloseTo(0.7 * 0.9 + 0.3 * 0.8);
  });

  it("deduplicates by id, keeping both scores", async () => {
    const results = await mergeHybridResults({
      vector: [
        { id: "1", path: "a.md", startLine: 1, endLine: 5, source: "memory", snippet: "hello", vectorScore: 0.9 },
        { id: "2", path: "b.md", startLine: 1, endLine: 3, source: "memory", snippet: "world", vectorScore: 0.5 },
      ],
      keyword: [
        { id: "1", path: "a.md", startLine: 1, endLine: 5, source: "memory", snippet: "hello", textScore: 0.8 },
      ],
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    expect(results).toHaveLength(2);
    // id "1" should score higher (has both vector and text)
    expect(results[0]!.path).toBe("a.md");
  });

  it("returns sorted by score descending", async () => {
    const results = await mergeHybridResults({
      vector: [
        { id: "1", path: "a.md", startLine: 1, endLine: 1, source: "memory", snippet: "low", vectorScore: 0.2 },
        { id: "2", path: "b.md", startLine: 1, endLine: 1, source: "memory", snippet: "high", vectorScore: 0.9 },
      ],
      keyword: [],
      vectorWeight: 1,
      textWeight: 0,
    });
    expect(results[0]!.snippet).toBe("high");
  });
});

describe("buildFtsQuery", () => {
  it("builds AND query from tokens", () => {
    expect(buildFtsQuery("hello world")).toBe('"hello" AND "world"');
  });

  it("returns null for empty input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("   ")).toBeNull();
  });

  it("strips quotes from tokens", () => {
    expect(buildFtsQuery('he"llo')).toBe('"hello"');
  });
});

describe("bm25RankToScore", () => {
  it("converts negative rank to 0-1 score", () => {
    const score = bm25RankToScore(-5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("higher negative rank = higher score", () => {
    expect(bm25RankToScore(-10)).toBeGreaterThan(bm25RankToScore(-1));
  });
});

describe("extractKeywords", () => {
  it("removes stop words", () => {
    const kw = extractKeywords("the quick brown fox");
    expect(kw).not.toContain("the");
    expect(kw).toContain("quick");
    expect(kw).toContain("brown");
    expect(kw).toContain("fox");
  });

  it("returns empty for all stop words", () => {
    expect(extractKeywords("the a an")).toEqual([]);
  });
});
```

```typescript
// src/memory/mmr.test.ts
import { describe, it, expect } from "vitest";
import { tokenize, jaccardSimilarity, applyMMR } from "./mmr.js";

describe("tokenize", () => {
  it("extracts lowercase tokens", () => {
    const tokens = tokenize("Hello World 123");
    expect(tokens).toEqual(new Set(["hello", "world", "123"]));
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const s = new Set(["a", "b"]);
    expect(jaccardSimilarity(s, s)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set(["b"]))).toBe(0);
  });

  it("returns 0.5 for 50% overlap", () => {
    expect(jaccardSimilarity(new Set(["a", "b"]), new Set(["a", "c"]))).toBeCloseTo(1 / 3);
  });
});

describe("applyMMR", () => {
  it("returns same order when disabled", () => {
    const items = [
      { score: 0.5, snippet: "first", path: "a.md", startLine: 1 },
      { score: 0.9, snippet: "second", path: "b.md", startLine: 1 },
    ];
    const result = applyMMR(items, { enabled: false });
    expect(result).toHaveLength(2);
  });

  it("promotes diverse results when enabled", () => {
    const items = [
      { score: 0.9, snippet: "the quick brown fox", path: "a.md", startLine: 1 },
      { score: 0.85, snippet: "the quick brown dog", path: "a.md", startLine: 10 },
      { score: 0.7, snippet: "something completely different about memory", path: "b.md", startLine: 1 },
    ];
    const result = applyMMR(items, { enabled: true, lambda: 0.5 });
    // With lambda=0.5, the diverse result should be promoted
    expect(result).toHaveLength(3);
    expect(result[0]!.score).toBe(0.9); // highest score always first
  });
});
```

**Step 6: Run tests**

Run: `pnpm test src/memory/hybrid.test.ts src/memory/mmr.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/memory/query-expansion.ts src/memory/hybrid.ts src/memory/temporal-decay.ts src/memory/mmr.ts src/memory/hybrid.test.ts src/memory/mmr.test.ts
git commit -m "feat(memory): add hybrid search, temporal decay, and MMR re-ranking"
```

---

### Task 4: Memory Manager (Search + Sync + Index)

**Files:**
- Create: `src/memory/manager.ts`
- Test: `src/memory/manager.test.ts`
- Create: `src/memory/index.ts`

This is the core orchestrator. Extracted from OpenClaw's manager.ts + manager-sync-ops.ts + manager-search.ts. Simplified: no class hierarchy (single object), no chokidar watcher (manual sync), no embedding providers for v1 (FTS-only mode — the design doc Non-Goals says "No vector search, v1 uses FTS5 only").

**Step 1: Create memory manager**

The manager provides: `search()`, `sync()`, `readFile()`, `status()`, `close()`.

For v1, this is FTS-only. Vector search support (embedding providers) is deferred — the schema tables exist but won't be populated until embedding providers are added.

```typescript
// src/memory/manager.ts
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs/promises";
import { ensureMemorySchema, FTS_TABLE } from "./schema.js";
import { hashText, chunkMarkdown, listMemoryFiles, buildFileEntry } from "./internal.js";
import { buildFtsQuery, bm25RankToScore, extractKeywords } from "./query-expansion.js";
import { mergeHybridResults } from "./hybrid.js";
import type { MemorySearchResult, MemoryProviderStatus, MemorySyncProgress } from "./types.js";
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
  search(query: string, opts?: { maxResults?: number; minScore?: number }): Promise<MemorySearchResult[]>;
  sync(opts?: { force?: boolean; progress?: (update: MemorySyncProgress) => void }): Promise<void>;
  readFile(relPath: string, from?: number, lines?: number): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  close(): void;
}

const DEFAULT_CHUNK_TOKENS = 400;
const DEFAULT_CHUNK_OVERLAP = 80;
const DEFAULT_MAX_RESULTS = 6;
const DEFAULT_MIN_SCORE = 0.05;

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const {
    dbPath,
    workspaceDir,
    chunkTokens = DEFAULT_CHUNK_TOKENS,
    chunkOverlap = DEFAULT_CHUNK_OVERLAP,
    vectorWeight = 0.7,
    textWeight = 0.3,
  } = config;

  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");

  const { ftsAvailable, ftsError } = ensureMemorySchema(db);
  let dirty = true;

  async function search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]> {
    const maxResults = opts?.maxResults ?? DEFAULT_MAX_RESULTS;
    const minScore = opts?.minScore ?? DEFAULT_MIN_SCORE;

    if (!ftsAvailable) {
      return []; // No search capability without FTS
    }

    // FTS-only search: extract keywords and query
    const keywords = extractKeywords(query);
    const allTerms = [query, ...keywords];
    const resultMap = new Map<string, MemorySearchResult>();

    for (const term of allTerms) {
      const ftsQuery = buildFtsQuery(term);
      if (!ftsQuery) continue;

      const candidateLimit = maxResults * 4;
      try {
        const rows = db.prepare(
          `SELECT id, path, source, start_line, end_line, text, rank
           FROM ${FTS_TABLE}
           WHERE ${FTS_TABLE} MATCH ?
           ORDER BY rank
           LIMIT ?`,
        ).all(ftsQuery, candidateLimit) as Array<{
          id: string; path: string; source: string;
          start_line: number; end_line: number; text: string; rank: number;
        }>;

        for (const row of rows) {
          const score = bm25RankToScore(row.rank);
          const existing = resultMap.get(row.id);
          if (!existing || score > existing.score) {
            resultMap.set(row.id, {
              path: row.path,
              startLine: row.start_line,
              endLine: row.end_line,
              score,
              snippet: row.text.slice(0, 300),
              source: row.source as "memory" | "sessions",
              citation: `${row.path}#L${row.start_line}-L${row.end_line}`,
            });
          }
        }
      } catch {
        // FTS query may fail for certain inputs — skip
      }
    }

    // Apply temporal decay and MMR if configured
    let results = Array.from(resultMap.values());

    const merged = await mergeHybridResults({
      vector: [],
      keyword: results.map((r, i) => ({
        id: `${r.path}:${r.startLine}:${i}`,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.score,
      })),
      vectorWeight: 0,
      textWeight: 1,
      workspaceDir,
      mmr: config.mmr,
      temporalDecay: config.temporalDecay,
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
    const files = await listMemoryFiles(workspaceDir);
    const total = files.length;
    let completed = 0;

    for (const absPath of files) {
      const entry = await buildFileEntry(absPath, workspaceDir);
      if (!entry) {
        completed++;
        opts?.progress?.({ completed, total });
        continue;
      }

      // Check if file changed
      const existing = db.prepare("SELECT hash FROM files WHERE path = ?").get(entry.path) as { hash: string } | undefined;
      if (existing && existing.hash === entry.hash && !opts?.force) {
        completed++;
        opts?.progress?.({ completed, total });
        continue;
      }

      // Read and chunk
      let content: string;
      try {
        content = await fs.readFile(absPath, "utf-8");
      } catch {
        completed++;
        opts?.progress?.({ completed, total });
        continue;
      }

      const chunks = chunkMarkdown(content, { tokens: chunkTokens, overlap: chunkOverlap });
      const now = Date.now();
      const model = "fts-only";

      // Delete old chunks for this file
      db.prepare("DELETE FROM chunks WHERE path = ?").run(entry.path);
      if (ftsAvailable) {
        try {
          db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(entry.path);
        } catch { /* FTS table may not exist */ }
      }

      // Insert new chunks
      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i]!;
        const id = `${entry.path}:${chunk.startLine}:${i}`;

        db.prepare(
          `INSERT OR REPLACE INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(id, entry.path, "memory", chunk.startLine, chunk.endLine, chunk.hash, model, chunk.text, "[]", now);

        if (ftsAvailable) {
          try {
            db.prepare(
              `INSERT INTO ${FTS_TABLE} (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)`,
            ).run(chunk.text, id, entry.path, "memory", model, chunk.startLine, chunk.endLine);
          } catch { /* ignore FTS errors */ }
        }
      }

      // Upsert file record
      db.prepare(
        `INSERT OR REPLACE INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)`,
      ).run(entry.path, "memory", entry.hash, Math.floor(entry.mtimeMs), entry.size);

      completed++;
      opts?.progress?.({ completed, total });
    }

    // Remove orphaned files
    const indexed = db.prepare("SELECT path FROM files WHERE source = 'memory'").all() as Array<{ path: string }>;
    const currentPaths = new Set(
      files.map((f) => path.relative(workspaceDir, f).replace(/\\/g, "/")),
    );
    for (const row of indexed) {
      if (!currentPaths.has(row.path)) {
        db.prepare("DELETE FROM chunks WHERE path = ?").run(row.path);
        db.prepare("DELETE FROM files WHERE path = ?").run(row.path);
        if (ftsAvailable) {
          try { db.prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ?`).run(row.path); } catch {}
        }
      }
    }

    dirty = false;
  }

  async function readFile(
    relPath: string,
    from?: number,
    lineCount?: number,
  ): Promise<{ text: string; path: string }> {
    const absPath = path.resolve(workspaceDir, relPath);
    // Prevent directory traversal
    if (!absPath.startsWith(path.resolve(workspaceDir))) {
      throw new Error("Path outside workspace");
    }
    const content = await fs.readFile(absPath, "utf-8");
    const lines = content.split("\n");
    const start = Math.max(0, (from ?? 1) - 1);
    const count = lineCount ?? lines.length;
    const slice = lines.slice(start, start + count);
    return { text: slice.join("\n"), path: relPath };
  }

  function status(): MemoryProviderStatus {
    const fileCount = (db.prepare("SELECT COUNT(*) as c FROM files").get() as { c: number }).c;
    const chunkCount = (db.prepare("SELECT COUNT(*) as c FROM chunks").get() as { c: number }).c;
    const cacheCount = (db.prepare("SELECT COUNT(*) as c FROM embedding_cache").get() as { c: number }).c;

    return {
      provider: "fts-only",
      files: fileCount,
      chunks: chunkCount,
      dirty,
      dbPath,
      fts: { enabled: true, available: ftsAvailable, error: ftsError },
      vector: { enabled: false },
      cache: { enabled: false, entries: cacheCount },
    };
  }

  function close(): void {
    db.close();
  }

  return { search, sync, readFile, status, close };
}
```

**Step 2: Create barrel export**

```typescript
// src/memory/index.ts
export { createMemoryManager } from "./manager.js";
export type { MemoryManager, MemoryManagerConfig } from "./manager.js";
export type { MemorySearchResult, MemoryProviderStatus, MemorySource } from "./types.js";
```

**Step 3: Write tests**

```typescript
// src/memory/manager.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createMemoryManager } from "./manager.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openclaude-test-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("createMemoryManager", () => {
  let workspaceDir: string;
  let dbPath: string;

  beforeEach(() => {
    workspaceDir = makeTempDir();
    dbPath = join(workspaceDir, "test.sqlite");
  });

  afterEach(() => {
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("creates manager and reports status", () => {
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    const s = mgr.status();
    expect(s.provider).toBe("fts-only");
    expect(s.files).toBe(0);
    expect(s.chunks).toBe(0);
    mgr.close();
  });

  it("syncs memory files and indexes them", async () => {
    writeFileSync(join(workspaceDir, "MEMORY.md"), "# My Memory\n\nImportant fact: the sky is blue.\n");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await mgr.sync();
    const s = mgr.status();
    expect(s.files).toBe(1);
    expect(s.chunks).toBeGreaterThan(0);
    mgr.close();
  });

  it("searches indexed content", async () => {
    writeFileSync(join(workspaceDir, "MEMORY.md"), "# Notes\n\nThe API key is stored in environment variables.\nDatabase connection uses PostgreSQL.\n");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await mgr.sync();
    const results = await mgr.search("API key environment");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.snippet).toContain("API");
    mgr.close();
  });

  it("detects file changes on re-sync", async () => {
    writeFileSync(join(workspaceDir, "MEMORY.md"), "version 1");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await mgr.sync();
    const s1 = mgr.status();

    writeFileSync(join(workspaceDir, "MEMORY.md"), "version 2 with new content about databases");
    await mgr.sync();
    const results = await mgr.search("databases");
    expect(results.length).toBeGreaterThan(0);
    mgr.close();
  });

  it("indexes memory/ subdirectory files", async () => {
    mkdirSync(join(workspaceDir, "memory"), { recursive: true });
    writeFileSync(join(workspaceDir, "memory", "2026-01-01.md"), "# Jan 1\n\nDiscussed project architecture.\n");
    writeFileSync(join(workspaceDir, "memory", "2026-01-02.md"), "# Jan 2\n\nReviewed code quality standards.\n");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await mgr.sync();
    expect(mgr.status().files).toBe(2);
    const results = await mgr.search("architecture");
    expect(results.length).toBeGreaterThan(0);
    mgr.close();
  });

  it("readFile reads from workspace", async () => {
    writeFileSync(join(workspaceDir, "MEMORY.md"), "line 1\nline 2\nline 3\n");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    const result = await mgr.readFile("MEMORY.md", 2, 1);
    expect(result.text).toBe("line 2");
    mgr.close();
  });

  it("readFile rejects paths outside workspace", async () => {
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await expect(mgr.readFile("../../etc/passwd")).rejects.toThrow("Path outside workspace");
    mgr.close();
  });

  it("removes orphaned files on sync", async () => {
    writeFileSync(join(workspaceDir, "MEMORY.md"), "hello");
    const mgr = createMemoryManager({ dbPath, workspaceDir });
    await mgr.sync();
    expect(mgr.status().files).toBe(1);

    // Delete the file and re-sync
    rmSync(join(workspaceDir, "MEMORY.md"));
    await mgr.sync();
    expect(mgr.status().files).toBe(0);
    mgr.close();
  });
});
```

**Step 4: Run tests**

Run: `pnpm test src/memory/manager.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/manager.ts src/memory/manager.test.ts src/memory/index.ts
git commit -m "feat(memory): add memory manager with FTS search and sync"
```

---

### Task 5: Cron Types, Store, and Schedule

**Files:**
- Create: `src/cron/types.ts`
- Create: `src/cron/store.ts`
- Create: `src/cron/schedule.ts`
- Test: `src/cron/schedule.test.ts`
- Test: `src/cron/store.test.ts`

**Step 1: Create cron types (simplified from OpenClaw)**

```typescript
// src/cron/types.ts

export type CronScheduleKind = "at" | "every" | "cron";

export type CronSchedule =
  | { kind: "at"; atMs: number; timezone?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; timezone?: string };

export type CronSessionTarget = "main" | "isolated";

export type CronDeliveryTarget = {
  channel: "telegram" | "slack";
  chatId: string;
};

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  prompt: string;
  target?: CronDeliveryTarget;
  sessionTarget: CronSessionTarget;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  state: CronJobState;
}

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  consecutiveErrors?: number;
  runningAtMs?: number;
}

export type CronRunStatus = "ok" | "error" | "skipped";

export interface CronRunOutcome {
  status: CronRunStatus;
  error?: string;
  summary?: string;
  durationMs?: number;
}

export interface CronStore {
  version: number;
  jobs: CronJob[];
}
```

**Step 2: Create store (extracted from OpenClaw store.ts)**

```typescript
// src/cron/store.ts
import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import type { CronStore } from "./types.js";

export function loadCronStore(filePath: string): CronStore {
  try {
    const content = readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(content) as CronStore;
    if (!parsed.jobs || !Array.isArray(parsed.jobs)) {
      return { version: 1, jobs: [] };
    }
    return parsed;
  } catch {
    return { version: 1, jobs: [] };
  }
}

export function saveCronStore(filePath: string, store: CronStore): void {
  const dir = dirname(filePath);
  mkdirSync(dir, { recursive: true });

  const content = JSON.stringify(store, null, 2);
  const tmpPath = `${filePath}.tmp`;

  // Atomic write: write to temp file then rename
  writeFileSync(tmpPath, content, { mode: 0o600 });
  renameSync(tmpPath, filePath);
}
```

**Step 3: Create schedule (extracted from OpenClaw schedule.ts)**

```typescript
// src/cron/schedule.ts
import { Cron } from "croner";
import type { CronSchedule } from "./types.js";

// LRU cache for Croner instances
const cronCache = new Map<string, Cron>();
const MAX_CACHE_SIZE = 512;

function getCron(expr: string, timezone?: string): Cron {
  const key = `${timezone ?? ""}\0${expr}`;
  let cron = cronCache.get(key);
  if (cron) return cron;

  if (cronCache.size >= MAX_CACHE_SIZE) {
    // Evict oldest entry
    const first = cronCache.keys().next().value;
    if (first) cronCache.delete(first);
  }

  cron = new Cron(expr, { timezone: timezone || undefined });
  cronCache.set(key, cron);
  return cron;
}

export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs > nowMs ? schedule.atMs : undefined;

    case "every": {
      const anchor = schedule.anchorMs ?? 0;
      const elapsed = nowMs - anchor;
      const periods = Math.ceil(elapsed / schedule.everyMs);
      return anchor + periods * schedule.everyMs;
    }

    case "cron": {
      const cron = getCron(schedule.expr, schedule.timezone);
      const next = cron.nextRun(new Date(nowMs));
      return next ? next.getTime() : undefined;
    }
  }
}

export function computePrevRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "at":
      return schedule.atMs <= nowMs ? schedule.atMs : undefined;

    case "every": {
      const anchor = schedule.anchorMs ?? 0;
      const elapsed = nowMs - anchor;
      if (elapsed < 0) return undefined;
      const periods = Math.floor(elapsed / schedule.everyMs);
      return anchor + periods * schedule.everyMs;
    }

    case "cron": {
      const cron = getCron(schedule.expr, schedule.timezone);
      const prev = cron.previousRun(new Date(nowMs));
      return prev ? prev.getTime() : undefined;
    }
  }
}

// For testing
export function clearScheduleCache(): void {
  cronCache.clear();
}
```

**Step 4: Write tests**

```typescript
// src/cron/schedule.test.ts
import { describe, it, expect } from "vitest";
import { computeNextRunAtMs, computePrevRunAtMs } from "./schedule.js";

describe("computeNextRunAtMs", () => {
  it("at schedule: returns atMs if in future", () => {
    const now = 1000;
    expect(computeNextRunAtMs({ kind: "at", atMs: 2000 }, now)).toBe(2000);
  });

  it("at schedule: returns undefined if in past", () => {
    expect(computeNextRunAtMs({ kind: "at", atMs: 500 }, 1000)).toBeUndefined();
  });

  it("every schedule: computes next interval", () => {
    const now = 5000;
    const next = computeNextRunAtMs({ kind: "every", everyMs: 3000 }, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThanOrEqual(now);
  });

  it("cron schedule: computes next fire time", () => {
    const now = Date.now();
    const next = computeNextRunAtMs({ kind: "cron", expr: "* * * * *" }, now);
    expect(next).toBeDefined();
    expect(next!).toBeGreaterThan(now);
  });
});

describe("computePrevRunAtMs", () => {
  it("cron schedule: returns previous fire time", () => {
    const now = Date.now();
    const prev = computePrevRunAtMs({ kind: "cron", expr: "* * * * *" }, now);
    expect(prev).toBeDefined();
    expect(prev!).toBeLessThanOrEqual(now);
  });
});
```

```typescript
// src/cron/store.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { rmSync, mkdirSync } from "node:fs";
import { loadCronStore, saveCronStore } from "./store.js";

describe("cron store", () => {
  const dir = join(tmpdir(), `openclaude-cron-test-${randomUUID().slice(0, 8)}`);
  const filePath = join(dir, "jobs.json");

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns empty store when file missing", () => {
    const store = loadCronStore(filePath);
    expect(store.jobs).toEqual([]);
  });

  it("saves and loads store", () => {
    const store = {
      version: 1,
      jobs: [{
        id: "test-1",
        name: "Test Job",
        schedule: { kind: "every" as const, everyMs: 60000 },
        prompt: "Do something",
        sessionTarget: "isolated" as const,
        enabled: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        state: {},
      }],
    };
    saveCronStore(filePath, store);
    const loaded = loadCronStore(filePath);
    expect(loaded.jobs).toHaveLength(1);
    expect(loaded.jobs[0]!.id).toBe("test-1");
  });
});
```

**Step 5: Run tests**

Run: `pnpm test src/cron/schedule.test.ts src/cron/store.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/cron/types.ts src/cron/store.ts src/cron/schedule.ts src/cron/schedule.test.ts src/cron/store.test.ts
git commit -m "feat(cron): add types, store persistence, and schedule computation"
```

---

### Task 6: Cron Service

**Files:**
- Create: `src/cron/service.ts`
- Test: `src/cron/service.test.ts`
- Create: `src/cron/index.ts`

Simplified from OpenClaw's massive service — no lanes, no failure alerts, no session reaper, no startup catchup. Core: add/remove/list/run jobs, arm timer, execute on schedule.

**Step 1: Create cron service**

```typescript
// src/cron/service.ts
import { randomUUID } from "node:crypto";
import { loadCronStore, saveCronStore } from "./store.js";
import { computeNextRunAtMs } from "./schedule.js";
import type { CronJob, CronStore, CronRunOutcome, CronDeliveryTarget } from "./types.js";

export interface CronServiceDeps {
  storePath: string;
  /** Execute an isolated agent job — returns outcome */
  runIsolatedJob: (job: CronJob) => Promise<CronRunOutcome>;
  /** Deliver result to a channel */
  deliverResult?: (target: CronDeliveryTarget, text: string) => Promise<void>;
}

export interface CronService {
  start(): void;
  stop(): void;
  list(): CronJob[];
  add(input: { name: string; schedule: CronJob["schedule"]; prompt: string; target?: CronDeliveryTarget; sessionTarget?: CronJob["sessionTarget"] }): CronJob;
  remove(id: string): boolean;
  run(id: string): Promise<CronRunOutcome>;
  getJob(id: string): CronJob | undefined;
  status(): { running: boolean; jobCount: number; enabledCount: number };
}

const MAX_TIMER_DELAY_MS = 60_000;
const MIN_REFIRE_GAP_MS = 2_000;

export function createCronService(deps: CronServiceDeps): CronService {
  let store: CronStore = { version: 1, jobs: [] };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let executing = false;

  function load(): void {
    store = loadCronStore(deps.storePath);
    // Ensure all jobs have state
    for (const job of store.jobs) {
      if (!job.state) job.state = {};
    }
  }

  function save(): void {
    saveCronStore(deps.storePath, store);
  }

  function recomputeNextRuns(): void {
    const now = Date.now();
    for (const job of store.jobs) {
      if (!job.enabled) {
        job.state.nextRunAtMs = undefined;
        continue;
      }
      if (job.state.runningAtMs) continue; // Don't change while running
      const next = computeNextRunAtMs(job.schedule, now);
      job.state.nextRunAtMs = next;
    }
  }

  function armTimer(): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!running) return;

    const now = Date.now();
    let nextAt: number | undefined;
    for (const job of store.jobs) {
      if (!job.enabled || job.state.nextRunAtMs == null) continue;
      if (nextAt == null || job.state.nextRunAtMs < nextAt) {
        nextAt = job.state.nextRunAtMs;
      }
    }

    if (nextAt == null) return;

    const delay = Math.max(nextAt - now, MIN_REFIRE_GAP_MS);
    const clamped = Math.min(delay, MAX_TIMER_DELAY_MS);
    timer = setTimeout(() => void onTick(), clamped);
  }

  async function onTick(): Promise<void> {
    if (executing) {
      armTimer();
      return;
    }
    executing = true;

    try {
      load(); // Reload store to catch external edits
      const now = Date.now();
      const dueJobs = store.jobs.filter(
        (j) => j.enabled && j.state.nextRunAtMs != null && j.state.nextRunAtMs <= now && !j.state.runningAtMs,
      );

      for (const job of dueJobs) {
        job.state.runningAtMs = now;
        save();

        const startedAt = Date.now();
        let outcome: CronRunOutcome;
        try {
          outcome = await deps.runIsolatedJob(job);
        } catch (err) {
          outcome = { status: "error", error: err instanceof Error ? err.message : String(err) };
        }
        const endedAt = Date.now();

        // Update job state
        job.state.runningAtMs = undefined;
        job.state.lastRunAtMs = startedAt;
        job.state.lastStatus = outcome.status;
        job.state.lastError = outcome.error;
        job.state.nextRunAtMs = computeNextRunAtMs(job.schedule, endedAt);

        if (outcome.status === "error") {
          job.state.consecutiveErrors = (job.state.consecutiveErrors ?? 0) + 1;
        } else {
          job.state.consecutiveErrors = 0;
        }

        // One-shot "at" jobs: disable after run
        if (job.schedule.kind === "at" && outcome.status !== "error") {
          job.enabled = false;
          job.state.nextRunAtMs = undefined;
        }

        job.updatedAt = endedAt;
        save();

        // Deliver result if target configured
        if (outcome.status === "ok" && outcome.summary && job.target && deps.deliverResult) {
          try {
            await deps.deliverResult(job.target, outcome.summary);
          } catch {
            // Best effort delivery
          }
        }
      }

      recomputeNextRuns();
      save();
    } finally {
      executing = false;
      armTimer();
    }
  }

  function start(): void {
    load();
    recomputeNextRuns();
    save();
    running = true;
    armTimer();
  }

  function stop(): void {
    running = false;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function list(): CronJob[] {
    return [...store.jobs];
  }

  function add(input: {
    name: string;
    schedule: CronJob["schedule"];
    prompt: string;
    target?: CronDeliveryTarget;
    sessionTarget?: CronJob["sessionTarget"];
  }): CronJob {
    const now = Date.now();
    const job: CronJob = {
      id: randomUUID().slice(0, 8),
      name: input.name,
      schedule: input.schedule,
      prompt: input.prompt,
      target: input.target,
      sessionTarget: input.sessionTarget ?? "isolated",
      enabled: true,
      createdAt: now,
      updatedAt: now,
      state: {
        nextRunAtMs: computeNextRunAtMs(input.schedule, now),
      },
    };
    store.jobs.push(job);
    save();
    armTimer();
    return job;
  }

  function remove(id: string): boolean {
    const idx = store.jobs.findIndex((j) => j.id === id);
    if (idx < 0) return false;
    store.jobs.splice(idx, 1);
    save();
    return true;
  }

  async function run(id: string): Promise<CronRunOutcome> {
    const job = store.jobs.find((j) => j.id === id);
    if (!job) return { status: "error", error: "Job not found" };

    const startedAt = Date.now();
    let outcome: CronRunOutcome;
    try {
      outcome = await deps.runIsolatedJob(job);
    } catch (err) {
      outcome = { status: "error", error: err instanceof Error ? err.message : String(err) };
    }

    job.state.lastRunAtMs = startedAt;
    job.state.lastStatus = outcome.status;
    job.state.lastError = outcome.error;
    job.updatedAt = Date.now();
    save();

    return outcome;
  }

  function getJob(id: string): CronJob | undefined {
    return store.jobs.find((j) => j.id === id);
  }

  function status() {
    return {
      running,
      jobCount: store.jobs.length,
      enabledCount: store.jobs.filter((j) => j.enabled).length,
    };
  }

  return { start, stop, list, add, remove, run, getJob, status };
}
```

**Step 2: Create barrel export**

```typescript
// src/cron/index.ts
export { createCronService } from "./service.js";
export type { CronService, CronServiceDeps } from "./service.js";
export type { CronJob, CronSchedule, CronRunOutcome, CronDeliveryTarget } from "./types.js";
```

**Step 3: Write tests**

```typescript
// src/cron/service.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { createCronService } from "./service.js";
import type { CronRunOutcome } from "./types.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `openclaude-cron-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("CronService", () => {
  let dir: string;
  let storePath: string;

  beforeEach(() => {
    dir = makeTempDir();
    storePath = join(dir, "jobs.json");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("starts with empty job list", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: async () => ({ status: "ok" }),
    });
    svc.start();
    expect(svc.list()).toEqual([]);
    expect(svc.status().jobCount).toBe(0);
    svc.stop();
  });

  it("adds and lists jobs", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: async () => ({ status: "ok" }),
    });
    svc.start();
    const job = svc.add({
      name: "Test",
      schedule: { kind: "every", everyMs: 60000 },
      prompt: "Do something",
    });
    expect(job.id).toBeDefined();
    expect(svc.list()).toHaveLength(1);
    expect(svc.status().enabledCount).toBe(1);
    svc.stop();
  });

  it("removes jobs", () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: async () => ({ status: "ok" }),
    });
    svc.start();
    const job = svc.add({
      name: "Test",
      schedule: { kind: "every", everyMs: 60000 },
      prompt: "test",
    });
    expect(svc.remove(job.id)).toBe(true);
    expect(svc.list()).toHaveLength(0);
    expect(svc.remove("nonexistent")).toBe(false);
    svc.stop();
  });

  it("runs a job manually", async () => {
    let ran = false;
    const svc = createCronService({
      storePath,
      runIsolatedJob: async () => {
        ran = true;
        return { status: "ok", summary: "Done" };
      },
    });
    svc.start();
    const job = svc.add({
      name: "Manual",
      schedule: { kind: "every", everyMs: 60000 },
      prompt: "test",
    });
    const result = await svc.run(job.id);
    expect(result.status).toBe("ok");
    expect(ran).toBe(true);
    expect(svc.getJob(job.id)!.state.lastStatus).toBe("ok");
    svc.stop();
  });

  it("persists jobs across service restarts", () => {
    const deps = {
      storePath,
      runIsolatedJob: async (): Promise<CronRunOutcome> => ({ status: "ok" }),
    };
    const svc1 = createCronService(deps);
    svc1.start();
    svc1.add({ name: "Persistent", schedule: { kind: "every", everyMs: 60000 }, prompt: "test" });
    svc1.stop();

    const svc2 = createCronService(deps);
    svc2.start();
    expect(svc2.list()).toHaveLength(1);
    expect(svc2.list()[0]!.name).toBe("Persistent");
    svc2.stop();
  });

  it("handles job execution errors gracefully", async () => {
    const svc = createCronService({
      storePath,
      runIsolatedJob: async () => {
        throw new Error("Agent crashed");
      },
    });
    svc.start();
    const job = svc.add({
      name: "Failing",
      schedule: { kind: "every", everyMs: 60000 },
      prompt: "fail",
    });
    const result = await svc.run(job.id);
    expect(result.status).toBe("error");
    expect(result.error).toContain("Agent crashed");
    expect(svc.getJob(job.id)!.state.consecutiveErrors).toBe(1);
    svc.stop();
  });
});
```

**Step 4: Run tests**

Run: `pnpm test src/cron/service.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/cron/types.ts src/cron/store.ts src/cron/schedule.ts src/cron/service.ts src/cron/index.ts src/cron/schedule.test.ts src/cron/store.test.ts src/cron/service.test.ts
git commit -m "feat(cron): add cron service with scheduling, persistence, and job management"
```

---

### Task 7: Heartbeat Runner

**Files:**
- Create: `src/cron/heartbeat.ts`
- Test: `src/cron/heartbeat.test.ts`

**Step 1: Create heartbeat runner**

```typescript
// src/cron/heartbeat.ts
import { readFileSync, existsSync } from "node:fs";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";

export interface HeartbeatConfig {
  enabled: boolean;
  every: number; // ms
  checklistPath: string;
  target?: CronDeliveryTarget;
}

export interface HeartbeatDeps {
  /** Run an isolated Claude Code session with the given prompt */
  runIsolated: (prompt: string) => Promise<CronRunOutcome>;
  /** Deliver text to a channel */
  deliver?: (target: CronDeliveryTarget, text: string) => Promise<void>;
}

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
  runOnce(): Promise<CronRunOutcome>;
  isRunning(): boolean;
}

export function createHeartbeatRunner(
  config: HeartbeatConfig,
  deps: HeartbeatDeps,
): HeartbeatRunner {
  let timer: ReturnType<typeof setInterval> | null = null;
  let running = false;
  let executing = false;

  async function runOnce(): Promise<CronRunOutcome> {
    if (executing) return { status: "skipped", error: "Already executing" };
    executing = true;

    try {
      // Read checklist
      if (!existsSync(config.checklistPath)) {
        return { status: "skipped", error: "No heartbeat checklist found" };
      }

      const checklist = readFileSync(config.checklistPath, "utf-8").trim();
      if (!checklist) {
        return { status: "skipped", error: "Empty heartbeat checklist" };
      }

      const prompt = [
        "You are running a periodic heartbeat check. Review this checklist and take action on any items that need attention.",
        "If everything looks good and no action is needed, respond with just: heartbeat ok",
        "If you took action or found something important, describe what you did.",
        "",
        "## Checklist",
        checklist,
      ].join("\n");

      const outcome = await deps.runIsolated(prompt);

      // Deliver if non-trivial response
      if (
        outcome.status === "ok" &&
        outcome.summary &&
        config.target &&
        deps.deliver &&
        !isHeartbeatOk(outcome.summary)
      ) {
        await deps.deliver(config.target, outcome.summary);
      }

      return outcome;
    } catch (err) {
      return { status: "error", error: err instanceof Error ? err.message : String(err) };
    } finally {
      executing = false;
    }
  }

  function start(): void {
    if (running) return;
    running = true;
    timer = setInterval(() => {
      void runOnce();
    }, config.every);
  }

  function stop(): void {
    running = false;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce, isRunning: () => running };
}

/** Check if the heartbeat response is just "all ok" */
function isHeartbeatOk(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  return (
    normalized === "heartbeat ok" ||
    normalized === "heartbeat: ok" ||
    normalized === "all good" ||
    normalized.startsWith("heartbeat ok")
  );
}

export { isHeartbeatOk };
```

**Step 2: Write tests**

```typescript
// src/cron/heartbeat.test.ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { createHeartbeatRunner, isHeartbeatOk } from "./heartbeat.js";

describe("isHeartbeatOk", () => {
  it("recognizes heartbeat ok variants", () => {
    expect(isHeartbeatOk("heartbeat ok")).toBe(true);
    expect(isHeartbeatOk("Heartbeat OK")).toBe(true);
    expect(isHeartbeatOk("heartbeat: ok")).toBe(true);
    expect(isHeartbeatOk("all good")).toBe(true);
    expect(isHeartbeatOk("heartbeat ok — nothing to report")).toBe(true);
  });

  it("rejects non-trivial responses", () => {
    expect(isHeartbeatOk("Found 3 failing tests")).toBe(false);
    expect(isHeartbeatOk("Deployed new version")).toBe(false);
  });
});

describe("HeartbeatRunner", () => {
  let dir: string;
  let checklistPath: string;

  beforeEach(() => {
    dir = join(tmpdir(), `openclaude-hb-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
    checklistPath = join(dir, "HEARTBEAT.md");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("skips when no checklist exists", async () => {
    const runner = createHeartbeatRunner(
      { enabled: true, every: 60000, checklistPath },
      { runIsolated: async () => ({ status: "ok" }) },
    );
    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.error).toContain("No heartbeat checklist");
  });

  it("runs agent with checklist content", async () => {
    writeFileSync(checklistPath, "- [ ] Check CI status\n- [ ] Review open PRs\n");
    let receivedPrompt = "";
    const runner = createHeartbeatRunner(
      { enabled: true, every: 60000, checklistPath },
      {
        runIsolated: async (prompt) => {
          receivedPrompt = prompt;
          return { status: "ok", summary: "heartbeat ok" };
        },
      },
    );
    const result = await runner.runOnce();
    expect(result.status).toBe("ok");
    expect(receivedPrompt).toContain("Check CI status");
  });

  it("delivers non-trivial results to target", async () => {
    writeFileSync(checklistPath, "- [ ] Check deploy\n");
    let delivered = "";
    const runner = createHeartbeatRunner(
      {
        enabled: true,
        every: 60000,
        checklistPath,
        target: { channel: "telegram", chatId: "123" },
      },
      {
        runIsolated: async () => ({ status: "ok", summary: "Deploy failed! 3 errors found." }),
        deliver: async (_target, text) => { delivered = text; },
      },
    );
    await runner.runOnce();
    expect(delivered).toContain("Deploy failed");
  });

  it("does not deliver heartbeat-ok responses", async () => {
    writeFileSync(checklistPath, "- [ ] Check status\n");
    let delivered = false;
    const runner = createHeartbeatRunner(
      {
        enabled: true,
        every: 60000,
        checklistPath,
        target: { channel: "telegram", chatId: "123" },
      },
      {
        runIsolated: async () => ({ status: "ok", summary: "heartbeat ok" }),
        deliver: async () => { delivered = true; },
      },
    );
    await runner.runOnce();
    expect(delivered).toBe(false);
  });

  it("prevents concurrent execution", async () => {
    writeFileSync(checklistPath, "- [ ] Check\n");
    let concurrentRuns = 0;
    let maxConcurrent = 0;

    const runner = createHeartbeatRunner(
      { enabled: true, every: 60000, checklistPath },
      {
        runIsolated: async () => {
          concurrentRuns++;
          maxConcurrent = Math.max(maxConcurrent, concurrentRuns);
          await new Promise((r) => setTimeout(r, 50));
          concurrentRuns--;
          return { status: "ok", summary: "ok" };
        },
      },
    );

    await Promise.all([runner.runOnce(), runner.runOnce()]);
    expect(maxConcurrent).toBe(1);
  });
});
```

**Step 3: Run tests**

Run: `pnpm test src/cron/heartbeat.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/cron/heartbeat.ts src/cron/heartbeat.test.ts
git commit -m "feat(cron): add heartbeat runner with checklist-based execution"
```

---

### Task 8: Wire Phase 2 into Gateway

**Files:**
- Modify: `src/config/types.ts`
- Modify: `src/config/schema.ts`
- Modify: `src/gateway/lifecycle.ts`
- Modify: `src/router/commands.ts`
- Modify: `src/router/router.ts`

**Step 1: Extend config types for cron**

Add `CronConfig` to `OpenClaudeConfig`:

```typescript
// In src/config/types.ts, add:
export interface CronConfig {
  enabled: boolean;
  storePath: string;
}
```

And add `cron: CronConfig` to `OpenClaudeConfig`.

**Step 2: Extend config schema**

```typescript
// In src/config/schema.ts, add:
export const CronSchema = z.object({
  enabled: z.boolean().default(false),
  storePath: z.string().default("~/.openclaude/cron/jobs.json"),
});
```

And add `cron: CronSchema.default({})` to `OpenClaudeConfigSchema`.

**Step 3: Add cron commands to router**

Add `/cron list`, `/cron add`, `/cron remove`, `/cron run`, `/memory status`, `/memory sync` to the command handlers.

**Step 4: Wire memory, cron, and heartbeat into gateway lifecycle**

Update `startGateway` to:
1. Create memory manager and run initial sync
2. Create cron service (if enabled) with `runIsolatedJob` wired to pool.submit
3. Create heartbeat runner (if enabled) with `runIsolated` wired to pool.submit
4. Create a `deliverResult` function that sends to the appropriate channel
5. On shutdown: stop heartbeat → stop cron → close memory DB

**Step 5: Update router to accept memory and cron dependencies**

Pass memory manager and cron service to `createRouter` and `createCommandHandlers`.

**Step 6: Run all tests**

Run: `pnpm test`
Expected: All existing + new tests PASS

**Step 7: Build**

Run: `pnpm build`
Expected: PASS with zero errors

**Step 8: Commit**

```bash
git add src/config/types.ts src/config/schema.ts src/gateway/lifecycle.ts src/router/commands.ts src/router/router.ts
git commit -m "feat: wire memory, cron, and heartbeat into gateway lifecycle"
```

---

## Summary

| Task | Module | Key Files | Tests |
|------|--------|-----------|-------|
| 1 | Memory types + schema | `src/memory/types.ts`, `schema.ts` | `schema.test.ts` |
| 2 | Chunking + utilities | `src/memory/internal.ts` | `internal.test.ts` |
| 3 | Hybrid search | `query-expansion.ts`, `hybrid.ts`, `temporal-decay.ts`, `mmr.ts` | `hybrid.test.ts`, `mmr.test.ts` |
| 4 | Memory manager | `src/memory/manager.ts`, `index.ts` | `manager.test.ts` |
| 5 | Cron types + store + schedule | `src/cron/types.ts`, `store.ts`, `schedule.ts` | `schedule.test.ts`, `store.test.ts` |
| 6 | Cron service | `src/cron/service.ts`, `index.ts` | `service.test.ts` |
| 7 | Heartbeat | `src/cron/heartbeat.ts` | `heartbeat.test.ts` |
| 8 | Gateway wiring | `lifecycle.ts`, `commands.ts`, `router.ts`, `types.ts`, `schema.ts` | existing tests |

**Total new files:** ~20
**Total new tests:** ~50+
**Estimated test files:** 8 new test files
