/**
 * Base class for memory manager operations: database management, file sync,
 * vector extension loading, and file watchers.
 * Ported from OpenClaw's manager-sync-ops.ts, adapted for OpenClaude's config.
 */
import { randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import chokidar, { FSWatcher } from "chokidar";
import { createLogger } from "../logging/logger.js";
import type { MemoryConfig } from "../config/types.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { GeminiEmbeddingClient } from "./embeddings-gemini.js";
import type { MistralEmbeddingClient } from "./embeddings-mistral.js";
import type { OllamaEmbeddingClient } from "./embeddings-ollama.js";
import type { OpenAiEmbeddingClient } from "./embeddings-openai.js";
import type { VoyageEmbeddingClient } from "./embeddings-voyage.js";
import { isFileMissingError } from "./fs-utils.js";
import {
  buildFileEntry,
  ensureDir,
  hashText,
  listMemoryFiles,
  normalizeExtraMemoryPaths,
  runWithConcurrency,
} from "./internal.js";
import { type MemoryFileEntry } from "./internal.js";
import { ensureMemoryIndexSchema } from "./schema.js";
import { loadSqliteVecExtension } from "./sqlite-vec.js";
import { requireNodeSqlite } from "./sqlite.js";
import type { MemorySource, MemorySyncProgressUpdate } from "./types.js";

type MemoryIndexMeta = {
  model: string;
  provider: string;
  providerKey?: string;
  sources?: MemorySource[];
  scopeHash?: string;
  chunkTokens: number;
  chunkOverlap: number;
  vectorDims?: number;
};

type MemorySyncProgressState = {
  completed: number;
  total: number;
  label?: string;
  report: (update: MemorySyncProgressUpdate) => void;
};

const META_KEY = "memory_index_meta_v1";
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const VECTOR_LOAD_TIMEOUT_MS = 30_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);

const log = createLogger("memory");

function shouldIgnoreMemoryWatchPath(watchPath: string): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized.split(path.sep).map((segment) => segment.trim().toLowerCase());
  return parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment));
}

export abstract class MemoryManagerSyncOps {
  protected abstract readonly workspaceDir: string;
  protected abstract readonly memoryConfig: MemoryConfig;
  protected provider: EmbeddingProvider | null = null;
  protected fallbackFrom?: "openai" | "gemini" | "voyage" | "mistral" | "ollama";
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected abstract batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected readonly sources: Set<MemorySource> = new Set();
  protected providerKey: string | null = null;
  protected abstract readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  protected readonly fts: {
    enabled: boolean;
    available: boolean;
    loadError?: string;
  } = { enabled: false, available: false };
  protected vectorReady: Promise<boolean> | null = null;
  protected watcher: FSWatcher | null = null;
  protected watchTimer: NodeJS.Timeout | null = null;
  protected fallbackReason?: string;
  protected intervalTimer: NodeJS.Timeout | null = null;
  protected closed = false;
  protected dirty = false;
  private lastMetaSerialized: string | null = null;

  protected abstract readonly cache: { enabled: boolean; maxEntries?: number };
  protected abstract db: DatabaseSync;
  protected abstract computeProviderKey(): string;
  protected abstract sync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  protected abstract withTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T>;
  protected abstract getIndexConcurrency(): number;
  protected abstract pruneEmbeddingCacheIfNeeded(): void;
  protected abstract indexFile(
    entry: MemoryFileEntry,
    options: { source: MemorySource; content?: string },
  ): Promise<void>;

  protected async ensureVectorReady(dimensions?: number): Promise<boolean> {
    if (!this.vector.enabled) {
      return false;
    }
    if (!this.vectorReady) {
      this.vectorReady = this.withTimeout(
        this.loadVectorExtension(),
        VECTOR_LOAD_TIMEOUT_MS,
        `sqlite-vec load timed out after ${Math.round(VECTOR_LOAD_TIMEOUT_MS / 1000)}s`,
      );
    }
    let ready = false;
    try {
      ready = (await this.vectorReady) || false;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      this.vectorReady = null;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
    if (ready && typeof dimensions === "number" && dimensions > 0) {
      this.ensureVectorTable(dimensions);
    }
    return ready;
  }

  private async loadVectorExtension(): Promise<boolean> {
    if (this.vector.available !== null) {
      return this.vector.available;
    }
    if (!this.vector.enabled) {
      this.vector.available = false;
      return false;
    }
    try {
      const resolvedPath = this.vector.extensionPath?.trim() || undefined;
      const loaded = await loadSqliteVecExtension({ db: this.db, extensionPath: resolvedPath });
      if (!loaded.ok) {
        throw new Error(loaded.error ?? "unknown sqlite-vec load error");
      }
      this.vector.extensionPath = loaded.extensionPath;
      this.vector.available = true;
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.vector.available = false;
      this.vector.loadError = message;
      log.warn(`sqlite-vec unavailable: ${message}`);
      return false;
    }
  }

  private ensureVectorTable(dimensions: number): void {
    if (this.vector.dims === dimensions) {
      return;
    }
    if (this.vector.dims && this.vector.dims !== dimensions) {
      this.dropVectorTable();
    }
    this.db.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${VECTOR_TABLE} USING vec0(\n` +
        `  id TEXT PRIMARY KEY,\n` +
        `  embedding FLOAT[${dimensions}]\n` +
        `)`,
    );
    this.vector.dims = dimensions;
  }

  private dropVectorTable(): void {
    try {
      this.db.exec(`DROP TABLE IF EXISTS ${VECTOR_TABLE}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.debug(`Failed to drop ${VECTOR_TABLE}: ${message}`);
    }
  }

  protected buildSourceFilter(alias?: string): { sql: string; params: MemorySource[] } {
    const sources = Array.from(this.sources);
    if (sources.length === 0) {
      return { sql: "", params: [] };
    }
    const column = alias ? `${alias}.source` : "source";
    const placeholders = sources.map(() => "?").join(", ");
    return { sql: ` AND ${column} IN (${placeholders})`, params: sources };
  }

  protected openDatabase(): DatabaseSync {
    const dbPath = this.memoryConfig.store.path ?? this.memoryConfig.dbPath;
    return this.openDatabaseAtPath(dbPath);
  }

  private openDatabaseAtPath(dbPath: string): DatabaseSync {
    const dir = path.dirname(dbPath);
    ensureDir(dir);
    const { DatabaseSync } = requireNodeSqlite();
    const db = new DatabaseSync(dbPath, { allowExtension: this.memoryConfig.store.vector.enabled });
    db.exec("PRAGMA busy_timeout = 5000");
    return db;
  }

  private seedEmbeddingCache(sourceDb: DatabaseSync): void {
    if (!this.cache.enabled) {
      return;
    }
    try {
      const rows = sourceDb
        .prepare(
          `SELECT provider, model, provider_key, hash, embedding, dims, updated_at FROM ${EMBEDDING_CACHE_TABLE}`,
        )
        .all() as Array<{
        provider: string;
        model: string;
        provider_key: string;
        hash: string;
        embedding: string;
        dims: number | null;
        updated_at: number;
      }>;
      if (!rows.length) {
        return;
      }
      const insert = this.db.prepare(
        `INSERT INTO ${EMBEDDING_CACHE_TABLE} (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(provider, model, provider_key, hash) DO UPDATE SET
           embedding=excluded.embedding,
           dims=excluded.dims,
           updated_at=excluded.updated_at`,
      );
      this.db.exec("BEGIN");
      for (const row of rows) {
        insert.run(
          row.provider,
          row.model,
          row.provider_key,
          row.hash,
          row.embedding,
          row.dims,
          row.updated_at,
        );
      }
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {}
      throw err;
    }
  }

  private async swapIndexFiles(targetPath: string, tempPath: string): Promise<void> {
    const backupPath = `${targetPath}.backup-${randomUUID()}`;
    await this.moveIndexFiles(targetPath, backupPath);
    try {
      await this.moveIndexFiles(tempPath, targetPath);
    } catch (err) {
      await this.moveIndexFiles(backupPath, targetPath);
      throw err;
    }
    await this.removeIndexFiles(backupPath);
  }

  private async moveIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    for (const suffix of suffixes) {
      const source = `${sourceBase}${suffix}`;
      const target = `${targetBase}${suffix}`;
      try {
        await fs.rename(source, target);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }
    }
  }

  private async removeIndexFiles(basePath: string): Promise<void> {
    const suffixes = ["", "-wal", "-shm"];
    await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
  }

  protected ensureSchema() {
    const result = ensureMemoryIndexSchema({
      db: this.db,
      embeddingCacheTable: EMBEDDING_CACHE_TABLE,
      ftsTable: FTS_TABLE,
      ftsEnabled: this.fts.enabled,
    });
    this.fts.available = result.ftsAvailable;
    if (result.ftsError) {
      this.fts.loadError = result.ftsError;
      if (this.fts.enabled) {
        log.warn(`fts unavailable: ${result.ftsError}`);
      }
    }
  }

  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.memoryConfig.sync.watch || this.watcher) {
      return;
    }
    const watchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "memory.md"),
      path.join(this.workspaceDir, "memory", "**", "*.md"),
    ]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.memoryConfig.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          watchPaths.add(path.join(entry, "**", "*.md"));
          continue;
        }
        if (stat.isFile() && entry.toLowerCase().endsWith(".md")) {
          watchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    this.watcher = chokidar.watch(Array.from(watchPaths), {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(String(watchPath)),
      awaitWriteFinish: {
        stabilityThreshold: this.memoryConfig.sync.watchDebounceMs,
        pollInterval: 100,
      },
    });
    const markDirty = () => {
      this.dirty = true;
      this.scheduleWatchSync();
    };
    this.watcher.on("add", markDirty);
    this.watcher.on("change", markDirty);
    this.watcher.on("unlink", markDirty);
  }

  protected ensureIntervalSync() {
    const minutes = this.memoryConfig.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = minutes * 60 * 1000;
    this.intervalTimer = setInterval(() => {
      void this.sync({ reason: "interval" }).catch((err) => {
        log.warn(`memory sync failed (interval): ${String(err)}`);
      });
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.memoryConfig.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void this.sync({ reason: "watch" }).catch((err) => {
        log.warn(`memory sync failed (watch): ${String(err)}`);
      });
    }, this.memoryConfig.sync.watchDebounceMs);
  }

  private async syncMemoryFiles(params: {
    needsFullReindex: boolean;
    progress?: MemorySyncProgressState;
  }) {
    // FTS-only mode: skip embedding sync (no provider)
    if (!this.provider) {
      log.debug("Skipping memory file sync in FTS-only mode (no embedding provider)");
      return;
    }

    const files = await listMemoryFiles(
      this.workspaceDir,
      this.memoryConfig.extraPaths,
    );
    const fileEntries = (
      await runWithConcurrency(
        files.map(
          (file) => async () =>
            await buildFileEntry(file, this.workspaceDir),
        ),
        this.getIndexConcurrency(),
      )
    ).filter((entry): entry is MemoryFileEntry => entry !== null);
    log.debug("memory sync: indexing memory files", {
      files: fileEntries.length,
      needsFullReindex: params.needsFullReindex,
      batch: this.batch.enabled,
      concurrency: this.getIndexConcurrency(),
    });
    const activePaths = new Set(fileEntries.map((entry) => entry.path));
    if (params.progress) {
      params.progress.total += fileEntries.length;
      params.progress.report({
        completed: params.progress.completed,
        total: params.progress.total,
        label: this.batch.enabled ? "Indexing memory files (batch)..." : "Indexing memory files...",
      });
    }

    const tasks = fileEntries.map((entry) => async () => {
      const record = this.db
        .prepare(`SELECT hash FROM files WHERE path = ? AND source = ?`)
        .get(entry.path, "memory") as { hash: string } | undefined;
      if (!params.needsFullReindex && record?.hash === entry.hash) {
        if (params.progress) {
          params.progress.completed += 1;
          params.progress.report({
            completed: params.progress.completed,
            total: params.progress.total,
          });
        }
        return;
      }
      await this.indexFile(entry, { source: "memory" });
      if (params.progress) {
        params.progress.completed += 1;
        params.progress.report({
          completed: params.progress.completed,
          total: params.progress.total,
        });
      }
    });
    await runWithConcurrency(tasks, this.getIndexConcurrency());

    const staleRows = this.db
      .prepare(`SELECT path FROM files WHERE source = ?`)
      .all("memory") as Array<{ path: string }>;
    for (const stale of staleRows) {
      if (activePaths.has(stale.path)) {
        continue;
      }
      this.db.prepare(`DELETE FROM files WHERE path = ? AND source = ?`).run(stale.path, "memory");
      try {
        this.db
          .prepare(
            `DELETE FROM ${VECTOR_TABLE} WHERE id IN (SELECT id FROM chunks WHERE path = ? AND source = ?)`,
          )
          .run(stale.path, "memory");
      } catch {}
      this.db.prepare(`DELETE FROM chunks WHERE path = ? AND source = ?`).run(stale.path, "memory");
      if (this.fts.enabled && this.fts.available && this.provider) {
        try {
          this.db
            .prepare(`DELETE FROM ${FTS_TABLE} WHERE path = ? AND source = ? AND model = ?`)
            .run(stale.path, "memory", this.provider.model);
        } catch {}
      }
    }
  }

  private createSyncProgress(
    onProgress: (update: MemorySyncProgressUpdate) => void,
  ): MemorySyncProgressState {
    const state: MemorySyncProgressState = {
      completed: 0,
      total: 0,
      label: undefined,
      report: (update) => {
        if (update.label) {
          state.label = update.label;
        }
        const label =
          update.total > 0 && state.label
            ? `${state.label} ${update.completed}/${update.total}`
            : state.label;
        onProgress({
          completed: update.completed,
          total: update.total,
          label,
        });
      },
    };
    return state;
  }

  protected async runSync(params?: {
    reason?: string;
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }) {
    const progress = params?.progress ? this.createSyncProgress(params.progress) : undefined;
    if (progress) {
      progress.report({
        completed: progress.completed,
        total: progress.total,
        label: "Loading vector extension...",
      });
    }
    const vectorReady = await this.ensureVectorReady();
    const meta = this.readMeta();
    const configuredSources = this.resolveConfiguredSourcesForMeta();
    const configuredScopeHash = this.resolveConfiguredScopeHash();
    const needsFullReindex =
      params?.force ||
      !meta ||
      (this.provider && meta.model !== this.provider.model) ||
      (this.provider && meta.provider !== this.provider.id) ||
      meta.providerKey !== this.providerKey ||
      this.metaSourcesDiffer(meta, configuredSources) ||
      meta.scopeHash !== configuredScopeHash ||
      meta.chunkTokens !== this.memoryConfig.chunking.tokens ||
      meta.chunkOverlap !== this.memoryConfig.chunking.overlap ||
      (vectorReady && !meta?.vectorDims);
    try {
      if (needsFullReindex) {
        await this.runSafeReindex({
          reason: params?.reason,
          force: params?.force,
          progress: progress ?? undefined,
        });
        return;
      }

      const shouldSyncMemory =
        this.sources.has("memory") && (params?.force || needsFullReindex || this.dirty);

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex: !!needsFullReindex, progress: progress ?? undefined });
        this.dirty = false;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const activated =
        this.shouldFallbackOnError(reason) && (await this.activateFallbackProvider(reason));
      if (activated) {
        await this.runSafeReindex({
          reason: params?.reason ?? "fallback",
          force: true,
          progress: progress ?? undefined,
        });
        return;
      }
      throw err;
    }
  }

  private shouldFallbackOnError(message: string): boolean {
    return /embedding|embeddings|batch/i.test(message);
  }

  protected resolveBatchConfig(): {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  } {
    const batch = this.memoryConfig.remote?.batch;
    const enabled = Boolean(
      batch?.enabled &&
      this.provider &&
      ((this.openAi && this.provider.id === "openai") ||
        (this.gemini && this.provider.id === "gemini") ||
        (this.voyage && this.provider.id === "voyage")),
    );
    return {
      enabled,
      wait: batch?.wait ?? true,
      concurrency: Math.max(1, batch?.concurrency ?? 2),
      pollIntervalMs: batch?.pollIntervalMs ?? 2000,
      timeoutMs: (batch?.timeoutMinutes ?? 60) * 60 * 1000,
    };
  }

  private async activateFallbackProvider(reason: string): Promise<boolean> {
    const fallback = this.memoryConfig.fallback;
    if (!fallback || fallback === "none" || !this.provider || fallback === this.provider.id) {
      return false;
    }
    if (this.fallbackFrom) {
      return false;
    }
    // Fallback provider creation is deferred to avoid circular deps.
    // For now, just log the attempt. Full fallback requires the embedding provider factory.
    log.warn(`memory embeddings: fallback requested to ${fallback} but not implemented in OpenClaude yet`, { reason });
    return false;
  }

  private async runSafeReindex(params: {
    reason?: string;
    force?: boolean;
    progress?: MemorySyncProgressState;
  }): Promise<void> {
    const dbPath = this.memoryConfig.store.path ?? this.memoryConfig.dbPath;
    const tempDbPath = `${dbPath}.tmp-${randomUUID()}`;
    const tempDb = this.openDatabaseAtPath(tempDbPath);

    const originalDb = this.db;
    let originalDbClosed = false;
    const originalState = {
      ftsAvailable: this.fts.available,
      ftsError: this.fts.loadError,
      vectorAvailable: this.vector.available,
      vectorLoadError: this.vector.loadError,
      vectorDims: this.vector.dims,
      vectorReady: this.vectorReady,
    };

    const restoreOriginalState = () => {
      if (originalDbClosed) {
        this.db = this.openDatabaseAtPath(dbPath);
      } else {
        this.db = originalDb;
      }
      this.fts.available = originalState.ftsAvailable;
      this.fts.loadError = originalState.ftsError;
      this.vector.available = originalDbClosed ? null : originalState.vectorAvailable;
      this.vector.loadError = originalState.vectorLoadError;
      this.vector.dims = originalState.vectorDims;
      this.vectorReady = originalDbClosed ? null : originalState.vectorReady;
    };

    this.db = tempDb;
    this.vectorReady = null;
    this.vector.available = null;
    this.vector.loadError = undefined;
    this.vector.dims = undefined;
    this.fts.available = false;
    this.fts.loadError = undefined;
    this.ensureSchema();

    let nextMeta: MemoryIndexMeta | null = null;

    try {
      this.seedEmbeddingCache(originalDb);
      const shouldSyncMemory = this.sources.has("memory");

      if (shouldSyncMemory) {
        await this.syncMemoryFiles({ needsFullReindex: true, progress: params.progress });
        this.dirty = false;
      }

      nextMeta = {
        model: this.provider?.model ?? "fts-only",
        provider: this.provider?.id ?? "none",
        providerKey: this.providerKey!,
        sources: this.resolveConfiguredSourcesForMeta(),
        scopeHash: this.resolveConfiguredScopeHash(),
        chunkTokens: this.memoryConfig.chunking.tokens,
        chunkOverlap: this.memoryConfig.chunking.overlap,
      };

      if (this.vector.available && this.vector.dims) {
        nextMeta.vectorDims = this.vector.dims;
      }

      this.writeMeta(nextMeta);
      this.pruneEmbeddingCacheIfNeeded?.();

      this.db.close();
      originalDb.close();
      originalDbClosed = true;

      await this.swapIndexFiles(dbPath, tempDbPath);

      this.db = this.openDatabaseAtPath(dbPath);
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      this.vector.dims = nextMeta?.vectorDims;
    } catch (err) {
      try {
        this.db.close();
      } catch {}
      await this.removeIndexFiles(tempDbPath);
      restoreOriginalState();
      throw err;
    }
  }

  protected readMeta(): MemoryIndexMeta | null {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = ?`).get(META_KEY) as
      | { value: string }
      | undefined;
    if (!row?.value) {
      this.lastMetaSerialized = null;
      return null;
    }
    try {
      const parsed = JSON.parse(row.value) as MemoryIndexMeta;
      this.lastMetaSerialized = row.value;
      return parsed;
    } catch {
      this.lastMetaSerialized = null;
      return null;
    }
  }

  protected writeMeta(meta: MemoryIndexMeta) {
    const value = JSON.stringify(meta);
    if (this.lastMetaSerialized === value) {
      return;
    }
    this.db
      .prepare(
        `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`,
      )
      .run(META_KEY, value);
    this.lastMetaSerialized = value;
  }

  private resolveConfiguredSourcesForMeta(): MemorySource[] {
    const normalized = Array.from(this.sources)
      .filter((source): source is MemorySource => source === "memory" || source === "sessions")
      .toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }

  private normalizeMetaSources(meta: MemoryIndexMeta): MemorySource[] {
    if (!Array.isArray(meta.sources)) {
      return ["memory"];
    }
    const normalized = Array.from(
      new Set(
        meta.sources.filter(
          (source): source is MemorySource => source === "memory" || source === "sessions",
        ),
      ),
    ).toSorted();
    return normalized.length > 0 ? normalized : ["memory"];
  }

  private resolveConfiguredScopeHash(): string {
    const extraPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.memoryConfig.extraPaths)
      .map((value) => value.replace(/\\/g, "/"))
      .toSorted();
    return hashText(
      JSON.stringify({
        extraPaths,
        multimodal: {
          enabled: this.memoryConfig.multimodal.enabled,
        },
      }),
    );
  }

  private metaSourcesDiffer(meta: MemoryIndexMeta, configuredSources: MemorySource[]): boolean {
    const metaSources = this.normalizeMetaSources(meta);
    if (metaSources.length !== configuredSources.length) {
      return true;
    }
    return metaSources.some((source, index) => source !== configuredSources[index]);
  }
}
