import type { DatabaseSync } from "node:sqlite";
import fs from "node:fs/promises";
import path from "node:path";
import { createLogger } from "../logging/logger.js";
import type { MemoryConfig } from "../config/types.js";
import { paths } from "../config/paths.js";
import {
  createEmbeddingProvider,
  type EmbeddingProvider,
  type EmbeddingProviderResult,
  type GeminiEmbeddingClient,
  type MistralEmbeddingClient,
  type OllamaEmbeddingClient,
  type OpenAiEmbeddingClient,
  type VoyageEmbeddingClient,
} from "./embeddings.js";
import { isFileMissingError, statRegularFile } from "./fs-utils.js";
import { bm25RankToScore, buildFtsQuery, mergeHybridResults } from "./hybrid.js";
import {
  isMemoryPath,
  normalizeExtraMemoryPaths,
  chunkMarkdown,
  listMemoryFiles,
  buildFileEntry,
} from "./internal.js";
import { MemoryManagerEmbeddingOps } from "./manager-embedding-ops.js";
import { searchKeyword, searchVector } from "./manager-search.js";
import { extractKeywords } from "./query-expansion.js";
import { ensureMemorySchema } from "./schema.js";
import { requireNodeSqlite } from "./sqlite.js";
import type {
  MemoryEmbeddingProbeResult,
  MemoryProviderStatus,
  MemorySearchManager,
  MemorySearchResult,
  MemorySource,
  MemorySyncProgressUpdate,
} from "./types.js";

const SNIPPET_MAX_CHARS = 700;
const VECTOR_TABLE = "chunks_vec";
const FTS_TABLE = "chunks_fts";
const EMBEDDING_CACHE_TABLE = "embedding_cache";
const BATCH_FAILURE_LIMIT = 2;

const log = createLogger("memory");

const INDEX_CACHE = new Map<string, MemoryIndexManager>();
const INDEX_CACHE_PENDING = new Map<string, Promise<MemoryIndexManager>>();

export async function closeAllMemoryIndexManagers(): Promise<void> {
  const pending = Array.from(INDEX_CACHE_PENDING.values());
  if (pending.length > 0) {
    await Promise.allSettled(pending);
  }
  const managers = Array.from(INDEX_CACHE.values());
  INDEX_CACHE.clear();
  for (const manager of managers) {
    try {
      await manager.close();
    } catch (err) {
      log.warn(`failed to close memory index manager: ${String(err)}`);
    }
  }
}

export class MemoryIndexManager extends MemoryManagerEmbeddingOps implements MemorySearchManager {
  private readonly cacheKey: string;
  protected readonly memoryConfig: MemoryConfig;
  protected readonly workspaceDir: string;
  protected provider: EmbeddingProvider | null;
  private readonly requestedProvider:
    | "openai"
    | "gemini"
    | "voyage"
    | "mistral"
    | "ollama"
    | "auto"
    | "none";
  protected fallbackFrom?: "openai" | "gemini" | "voyage" | "mistral" | "ollama";
  protected fallbackReason?: string;
  private readonly providerUnavailableReason?: string;
  protected openAi?: OpenAiEmbeddingClient;
  protected gemini?: GeminiEmbeddingClient;
  protected voyage?: VoyageEmbeddingClient;
  protected mistral?: MistralEmbeddingClient;
  protected ollama?: OllamaEmbeddingClient;
  protected batch: {
    enabled: boolean;
    wait: boolean;
    concurrency: number;
    pollIntervalMs: number;
    timeoutMs: number;
  };
  protected batchFailureCount = 0;
  protected batchFailureLastError?: string;
  protected batchFailureLastProvider?: string;
  protected batchFailureLock: Promise<void> = Promise.resolve();
  protected db: DatabaseSync;
  protected providerKey: string;
  protected readonly cache: { enabled: boolean; maxEntries?: number };
  protected readonly vector: {
    enabled: boolean;
    available: boolean | null;
    extensionPath?: string;
    loadError?: string;
    dims?: number;
  };
  private syncing: Promise<void> | null = null;
  private readonlyRecoveryAttempts = 0;
  private readonlyRecoverySuccesses = 0;
  private readonlyRecoveryFailures = 0;
  private readonlyRecoveryLastError?: string;

  static async get(params: {
    memoryConfig: MemoryConfig;
    workspaceDir?: string;
    purpose?: "default" | "status";
  }): Promise<MemoryIndexManager | null> {
    const { memoryConfig } = params;
    if (!memoryConfig.enabled) {
      return null;
    }
    const workspaceDir = params.workspaceDir ?? paths.base;
    const key = `${workspaceDir}:${JSON.stringify(memoryConfig)}`;
    const existing = INDEX_CACHE.get(key);
    if (existing) {
      return existing;
    }
    const pending = INDEX_CACHE_PENDING.get(key);
    if (pending) {
      return pending;
    }
    const createPromise = (async () => {
      let providerResult: EmbeddingProviderResult;
      if (memoryConfig.provider === "none") {
        providerResult = {
          provider: null,
          requestedProvider: "auto",
          providerUnavailableReason: "Embeddings disabled (provider=none)",
        };
      } else {
        providerResult = await createEmbeddingProvider({
          provider: memoryConfig.provider as Exclude<typeof memoryConfig.provider, "none">,
          model: memoryConfig.model ?? "text-embedding-3-small",
          outputDimensionality: memoryConfig.outputDimensionality,
          fallback: memoryConfig.fallback,
          remote: memoryConfig.remote,
        });
      }
      const refreshed = INDEX_CACHE.get(key);
      if (refreshed) {
        return refreshed;
      }
      const manager = new MemoryIndexManager({
        cacheKey: key,
        memoryConfig,
        workspaceDir,
        providerResult,
        purpose: params.purpose,
      });
      INDEX_CACHE.set(key, manager);
      return manager;
    })();
    INDEX_CACHE_PENDING.set(key, createPromise);
    try {
      return await createPromise;
    } finally {
      if (INDEX_CACHE_PENDING.get(key) === createPromise) {
        INDEX_CACHE_PENDING.delete(key);
      }
    }
  }

  constructor(params: {
    cacheKey: string;
    memoryConfig: MemoryConfig;
    workspaceDir: string;
    providerResult: EmbeddingProviderResult;
    purpose?: "default" | "status";
  }) {
    super();
    this.cacheKey = params.cacheKey;
    this.memoryConfig = params.memoryConfig;
    this.workspaceDir = params.workspaceDir;
    this.provider = params.providerResult.provider;
    this.requestedProvider = params.providerResult.requestedProvider as
      | "openai"
      | "gemini"
      | "voyage"
      | "mistral"
      | "ollama"
      | "auto"
      | "none";
    this.fallbackFrom = params.providerResult.fallbackFrom;
    this.fallbackReason = params.providerResult.fallbackReason;
    this.providerUnavailableReason = params.providerResult.providerUnavailableReason;
    this.openAi = params.providerResult.openAi;
    this.gemini = params.providerResult.gemini;
    this.voyage = params.providerResult.voyage;
    this.mistral = params.providerResult.mistral;
    this.ollama = params.providerResult.ollama;
    for (const source of params.memoryConfig.sources) {
      this.sources.add(source);
    }
    this.db = this.openDatabase();
    this.providerKey = this.computeProviderKey();
    this.cache = {
      enabled: params.memoryConfig.cache.enabled,
      maxEntries: params.memoryConfig.cache.maxEntries,
    };
    this.fts.enabled = params.memoryConfig.query.hybrid.enabled;
    this.ensureSchema();
    this.vector = {
      enabled: params.memoryConfig.store.vector.enabled,
      available: null,
      extensionPath: params.memoryConfig.store.vector.extensionPath,
    };
    const meta = this.readMeta();
    if (meta?.vectorDims) {
      this.vector.dims = meta.vectorDims;
    }
    this.ensureWatcher();
    this.ensureIntervalSync();
    const statusOnly = params.purpose === "status";
    this.dirty = this.sources.has("memory") && (statusOnly ? !meta : true);
    this.batch = this.resolveBatchConfig();
  }

  async search(
    query: string,
    opts?: {
      maxResults?: number;
      minScore?: number;
      sessionKey?: string;
    },
  ): Promise<MemorySearchResult[]> {
    if (this.memoryConfig.sync.onSearch && this.dirty) {
      void this.sync({ reason: "search" }).catch((err) => {
        log.warn(`memory sync failed (search): ${String(err)}`);
      });
    }
    const cleaned = query.trim();
    if (!cleaned) {
      return [];
    }
    const minScore = opts?.minScore ?? this.memoryConfig.query.minScore;
    const maxResults = opts?.maxResults ?? this.memoryConfig.query.maxResults;
    const hybrid = this.memoryConfig.query.hybrid;
    const candidates = Math.min(
      200,
      Math.max(1, Math.floor(maxResults * hybrid.candidateMultiplier)),
    );

    // FTS-only mode: no embedding provider available
    if (!this.provider) {
      if (!this.fts.enabled || !this.fts.available) {
        log.warn("memory search: no provider and FTS unavailable");
        return [];
      }

      const keywords = extractKeywords(cleaned);
      const searchTerms = keywords.length > 0 ? keywords : [cleaned];

      const resultSets = await Promise.all(
        searchTerms.map((term) => this.searchKeyword(term, candidates).catch(() => [])),
      );

      const seenIds = new Map<string, (typeof resultSets)[0][0]>();
      for (const results of resultSets) {
        for (const result of results) {
          const existing = seenIds.get(result.id);
          if (!existing || result.score > existing.score) {
            seenIds.set(result.id, result);
          }
        }
      }

      const merged = [...seenIds.values()]
        .toSorted((a, b) => b.score - a.score)
        .filter((entry) => entry.score >= minScore)
        .slice(0, maxResults);

      return merged;
    }

    // If FTS isn't available, degrade to vector-only.
    const keywordResults =
      hybrid.enabled && this.fts.enabled && this.fts.available
        ? await this.searchKeyword(cleaned, candidates).catch(() => [])
        : [];

    const queryVec = await this.embedQueryWithTimeout(cleaned);
    const hasVector = queryVec.some((v) => v !== 0);
    const vectorResults = hasVector
      ? await this.searchVector(queryVec, candidates).catch(() => [])
      : [];

    if (!hybrid.enabled || !this.fts.enabled || !this.fts.available) {
      return vectorResults.filter((entry) => entry.score >= minScore).slice(0, maxResults);
    }

    const merged = await this.mergeHybridResults({
      vector: vectorResults,
      keyword: keywordResults,
      vectorWeight: hybrid.vectorWeight,
      textWeight: hybrid.textWeight,
      mmr: hybrid.mmr,
      temporalDecay: hybrid.temporalDecay,
    });
    const strict = merged.filter((entry) => entry.score >= minScore);
    if (strict.length > 0 || keywordResults.length === 0) {
      return strict.slice(0, maxResults);
    }

    const relaxedMinScore = Math.min(minScore, hybrid.textWeight);
    const keywordKeys = new Set(
      keywordResults.map(
        (entry) => `${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`,
      ),
    );
    return merged
      .filter(
        (entry) =>
          keywordKeys.has(`${entry.source}:${entry.path}:${entry.startLine}:${entry.endLine}`) &&
          entry.score >= relaxedMinScore,
      )
      .slice(0, maxResults);
  }

  private async searchVector(
    queryVec: number[],
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string }>> {
    if (!this.provider) {
      return [];
    }
    const results = await searchVector({
      db: this.db,
      vectorTable: VECTOR_TABLE,
      providerModel: this.provider.model,
      queryVec,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      ensureVectorReady: async (dimensions) => await this.ensureVectorReady(dimensions),
      sourceFilterVec: this.buildSourceFilter("c"),
      sourceFilterChunks: this.buildSourceFilter(),
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string });
  }

  private buildFtsQueryStr(raw: string): string | null {
    return buildFtsQuery(raw);
  }

  private async searchKeyword(
    query: string,
    limit: number,
  ): Promise<Array<MemorySearchResult & { id: string; textScore: number }>> {
    if (!this.fts.enabled || !this.fts.available) {
      return [];
    }
    const sourceFilter = this.buildSourceFilter();
    const providerModel = this.provider?.model;
    const results = await searchKeyword({
      db: this.db,
      ftsTable: FTS_TABLE,
      providerModel,
      query,
      limit,
      snippetMaxChars: SNIPPET_MAX_CHARS,
      sourceFilter,
      buildFtsQuery: (raw) => this.buildFtsQueryStr(raw),
      bm25RankToScore,
    });
    return results.map((entry) => entry as MemorySearchResult & { id: string; textScore: number });
  }

  private mergeHybridResults(params: {
    vector: Array<MemorySearchResult & { id: string }>;
    keyword: Array<MemorySearchResult & { id: string; textScore: number }>;
    vectorWeight: number;
    textWeight: number;
    mmr?: { enabled: boolean; lambda: number };
    temporalDecay?: { enabled: boolean; halfLifeDays: number };
  }): Promise<MemorySearchResult[]> {
    return mergeHybridResults({
      vector: params.vector.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        vectorScore: r.score,
      })),
      keyword: params.keyword.map((r) => ({
        id: r.id,
        path: r.path,
        startLine: r.startLine,
        endLine: r.endLine,
        source: r.source,
        snippet: r.snippet,
        textScore: r.textScore,
      })),
      vectorWeight: params.vectorWeight,
      textWeight: params.textWeight,
      mmr: params.mmr,
      temporalDecay: params.temporalDecay,
      workspaceDir: this.workspaceDir,
    }).then((entries) => entries.map((entry) => entry as MemorySearchResult));
  }

  async sync(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    if (this.closed) {
      return;
    }
    if (this.syncing) {
      return this.syncing;
    }
    this.syncing = this.runSyncWithReadonlyRecovery(params).finally(() => {
      this.syncing = null;
    });
    return this.syncing ?? Promise.resolve();
  }

  private isReadonlyDbError(err: unknown): boolean {
    const readonlyPattern =
      /attempt to write a readonly database|database is read-only|SQLITE_READONLY/i;
    const messages = new Set<string>();

    const pushValue = (value: unknown): void => {
      if (typeof value !== "string") {
        return;
      }
      const normalized = value.trim();
      if (!normalized) {
        return;
      }
      messages.add(normalized);
    };

    pushValue(err instanceof Error ? err.message : String(err));
    if (err && typeof err === "object") {
      const record = err as Record<string, unknown>;
      pushValue(record.message);
      pushValue(record.code);
      pushValue(record.name);
      if (record.cause && typeof record.cause === "object") {
        const cause = record.cause as Record<string, unknown>;
        pushValue(cause.message);
        pushValue(cause.code);
        pushValue(cause.name);
      }
    }

    return [...messages].some((value) => readonlyPattern.test(value));
  }

  private async runSyncWithReadonlyRecovery(params?: {
    reason?: string;
    force?: boolean;
    sessionFiles?: string[];
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void> {
    try {
      await this.runSync(params);
      return;
    } catch (err) {
      if (!this.isReadonlyDbError(err) || this.closed) {
        throw err;
      }
      const reason = err instanceof Error ? err.message : String(err);
      this.readonlyRecoveryAttempts += 1;
      this.readonlyRecoveryLastError = reason;
      log.warn(`memory sync readonly handle detected; reopening sqlite connection`, { reason });
      try {
        this.db.close();
      } catch {}
      this.db = this.openDatabase();
      this.vectorReady = null;
      this.vector.available = null;
      this.vector.loadError = undefined;
      this.ensureSchema();
      const meta = this.readMeta();
      this.vector.dims = meta?.vectorDims;
      try {
        await this.runSync(params);
        this.readonlyRecoverySuccesses += 1;
      } catch (retryErr) {
        this.readonlyRecoveryFailures += 1;
        throw retryErr;
      }
    }
  }

  async readFile(params: {
    relPath: string;
    from?: number;
    lines?: number;
  }): Promise<{ text: string; path: string }> {
    const rawPath = params.relPath.trim();
    if (!rawPath) {
      throw new Error("path required");
    }
    const absPath = path.isAbsolute(rawPath)
      ? path.resolve(rawPath)
      : path.resolve(this.workspaceDir, rawPath);
    const relPath = path.relative(this.workspaceDir, absPath).replace(/\\/g, "/");
    const inWorkspace =
      relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
    const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
    let allowedAdditional = false;
    if (!allowedWorkspace && this.memoryConfig.extraPaths.length > 0) {
      const additionalPaths = normalizeExtraMemoryPaths(
        this.workspaceDir,
        this.memoryConfig.extraPaths,
      );
      for (const additionalPath of additionalPaths) {
        try {
          const stat = await fs.lstat(additionalPath);
          if (stat.isSymbolicLink()) {
            continue;
          }
          if (stat.isDirectory()) {
            if (absPath === additionalPath || absPath.startsWith(`${additionalPath}${path.sep}`)) {
              allowedAdditional = true;
              break;
            }
            continue;
          }
          if (stat.isFile()) {
            if (absPath === additionalPath && absPath.endsWith(".md")) {
              allowedAdditional = true;
              break;
            }
          }
        } catch {}
      }
    }
    if (!allowedWorkspace && !allowedAdditional) {
      throw new Error("path required");
    }
    if (!absPath.endsWith(".md")) {
      throw new Error("path required");
    }
    const statResult = await statRegularFile(absPath);
    if (statResult.missing) {
      return { text: "", path: relPath };
    }
    let content: string;
    try {
      content = await fs.readFile(absPath, "utf-8");
    } catch (err) {
      if (isFileMissingError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }
    if (!params.from && !params.lines) {
      return { text: content, path: relPath };
    }
    const lines = content.split("\n");
    const start = Math.max(1, params.from ?? 1);
    const count = Math.max(1, params.lines ?? lines.length);
    const slice = lines.slice(start - 1, start - 1 + count);
    return { text: slice.join("\n"), path: relPath };
  }

  status(): MemoryProviderStatus {
    const sourceFilter = this.buildSourceFilter();
    const files = this.db
      .prepare(`SELECT COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const chunks = this.db
      .prepare(`SELECT COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql}`)
      .get(...sourceFilter.params) as {
      c: number;
    };
    const sourceCounts = (() => {
      const sources = Array.from(this.sources);
      if (sources.length === 0) {
        return [];
      }
      const bySource = new Map<MemorySource, { files: number; chunks: number }>();
      for (const source of sources) {
        bySource.set(source, { files: 0, chunks: 0 });
      }
      const fileRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM files WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of fileRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.files = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      const chunkRows = this.db
        .prepare(
          `SELECT source, COUNT(*) as c FROM chunks WHERE 1=1${sourceFilter.sql} GROUP BY source`,
        )
        .all(...sourceFilter.params) as Array<{ source: MemorySource; c: number }>;
      for (const row of chunkRows) {
        const entry = bySource.get(row.source) ?? { files: 0, chunks: 0 };
        entry.chunks = row.c ?? 0;
        bySource.set(row.source, entry);
      }
      return sources.map((source) => Object.assign({ source }, bySource.get(source)!));
    })();

    const searchMode = this.provider ? "hybrid" : "fts-only";
    const providerInfo = this.provider
      ? { provider: this.provider.id, model: this.provider.model }
      : { provider: "none", model: undefined };

    return {
      backend: "builtin",
      files: files?.c ?? 0,
      chunks: chunks?.c ?? 0,
      dirty: this.dirty,
      workspaceDir: this.workspaceDir,
      dbPath: this.memoryConfig.dbPath,
      provider: providerInfo.provider,
      model: providerInfo.model,
      requestedProvider: this.requestedProvider,
      sources: Array.from(this.sources),
      extraPaths: this.memoryConfig.extraPaths,
      sourceCounts,
      cache: this.cache.enabled
        ? {
            enabled: true,
            entries:
              (
                this.db.prepare(`SELECT COUNT(*) as c FROM ${EMBEDDING_CACHE_TABLE}`).get() as
                  | { c: number }
                  | undefined
              )?.c ?? 0,
            maxEntries: this.cache.maxEntries,
          }
        : { enabled: false, maxEntries: this.cache.maxEntries },
      fts: {
        enabled: this.fts.enabled,
        available: this.fts.available,
        error: this.fts.loadError,
      },
      fallback: this.fallbackReason
        ? { from: this.fallbackFrom ?? "none", reason: this.fallbackReason }
        : undefined,
      vector: {
        enabled: this.vector.enabled,
        available: this.vector.available ?? undefined,
        extensionPath: this.vector.extensionPath,
        loadError: this.vector.loadError,
        dims: this.vector.dims,
      },
      batch: {
        enabled: this.batch.enabled,
        failures: this.batchFailureCount,
        limit: BATCH_FAILURE_LIMIT,
        wait: this.batch.wait,
        concurrency: this.batch.concurrency,
        pollIntervalMs: this.batch.pollIntervalMs,
        timeoutMs: this.batch.timeoutMs,
        lastError: this.batchFailureLastError,
        lastProvider: this.batchFailureLastProvider,
      },
      custom: {
        searchMode,
        providerUnavailableReason: this.providerUnavailableReason,
        readonlyRecovery: {
          attempts: this.readonlyRecoveryAttempts,
          successes: this.readonlyRecoverySuccesses,
          failures: this.readonlyRecoveryFailures,
          lastError: this.readonlyRecoveryLastError,
        },
      },
    };
  }

  async probeVectorAvailability(): Promise<boolean> {
    if (!this.provider) {
      return false;
    }
    if (!this.vector.enabled) {
      return false;
    }
    return this.ensureVectorReady();
  }

  async probeEmbeddingAvailability(): Promise<MemoryEmbeddingProbeResult> {
    if (!this.provider) {
      return {
        ok: false,
        error: this.providerUnavailableReason ?? "No embedding provider available (FTS-only mode)",
      };
    }
    try {
      await this.embedBatchWithRetry(["ping"]);
      return { ok: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: message };
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const pendingSync = this.syncing;
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = null;
    }
    if (pendingSync) {
      try {
        await pendingSync;
      } catch {}
    }
    this.db.close();
    INDEX_CACHE.delete(this.cacheKey);
  }
}

// ---------- Backward compatibility ----------

export interface MemoryManager {
  search(
    query: string,
    opts?: { maxResults?: number; minScore?: number },
  ): Promise<MemorySearchResult[]>;
  sync(opts?: {
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
  }): Promise<void>;
  readFile(
    relPath: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string; path: string }>;
  status(): MemoryProviderStatus;
  close(): void;
}

export interface MemoryManagerConfig {
  dbPath: string;
  workspaceDir: string;
  chunkTokens?: number;
  chunkOverlap?: number;
  vectorWeight?: number;
  textWeight?: number;
}

export function createMemoryManager(config: MemoryManagerConfig): MemoryManager {
  const {
    dbPath,
    workspaceDir,
    chunkTokens = 400,
    chunkOverlap = 80,
  } = config;

  const { DatabaseSync: SqliteSync } = requireNodeSqlite();
  const db = new SqliteSync(dbPath);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");

  const { ftsAvailable } = ensureMemorySchema(db);
  let dirty = true;
  const FTS_TABLE_NAME = "chunks_fts";

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
           FROM ${FTS_TABLE_NAME}
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

  async function syncFn(opts?: {
    force?: boolean;
    progress?: (update: MemorySyncProgressUpdate) => void;
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

      if (ftsAvailable) {
        db.prepare(`DELETE FROM ${FTS_TABLE_NAME} WHERE path = ?`).run(entry.path);
      }
      db.prepare("DELETE FROM chunks WHERE path = ?").run(entry.path);

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
            `INSERT INTO ${FTS_TABLE_NAME} (text, id, path, source, model, start_line, end_line)
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

      db.prepare(
        `INSERT INTO files (path, source, hash, mtime, size)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(path, source) DO UPDATE SET
           hash = excluded.hash,
           mtime = excluded.mtime,
           size = excluded.size`,
      ).run(entry.path, "memory", entry.hash, Math.floor(entry.mtimeMs), entry.size);

      completed++;
      if (progress) progress({ completed, total, label: entry.path });
    }

    const dbFiles = db
      .prepare("SELECT path FROM files")
      .all() as Array<{ path: string }>;

    for (const row of dbFiles) {
      if (!indexedPaths.has(row.path)) {
        if (ftsAvailable) {
          db.prepare(`DELETE FROM ${FTS_TABLE_NAME} WHERE path = ?`).run(row.path);
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
      const startIdx = Math.max(0, from - 1);
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

    return {
      backend: "builtin",
      provider: "fts-only",
      files: fileCount,
      chunks: chunkCount,
      dirty,
      dbPath,
      fts: { enabled: true, available: ftsAvailable },
      vector: { enabled: false },
      cache: { enabled: false },
    };
  }

  function close(): void {
    db.close();
  }

  return { search, sync: syncFn, readFile, status, close };
}
