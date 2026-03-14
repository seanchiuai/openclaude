# Memory System Port Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace OpenClaude's FTS-only memory system with OpenClaw's full implementation — embedding providers, vector search, batch APIs, file watching, multimodal, and multilingual query handling.

**Architecture:** Copy OpenClaw's memory files directly, adapting only the SSRF/remote-http layer (replace with plain `fetch`) and config resolution (use OpenClaude's flat `config.json` instead of OpenClaw's per-agent YAML). The manager class hierarchy (MemoryIndexManager → MemoryManagerEmbeddingOps → MemoryManagerSyncOps) is preserved.

**Tech Stack:** Node 22+ (node:sqlite), sqlite-vec, chokidar, sharp, pdfjs-dist, file-type, Vitest

---

## Phase 1: Foundation — Dependencies, DB Layer, Embedding Providers

### Task 1: Add npm dependencies

**Files:**
- Modify: `package.json`

**Step 1: Add dependencies**

Add these to `dependencies` in `package.json`:
```json
"sqlite-vec": "0.1.7-alpha.2",
"chokidar": "^5.0.0",
"sharp": "^0.34.5",
"pdfjs-dist": "^5.5.207",
"file-type": "^21.3.1"
```

**Step 2: Install**

Run: `pnpm install`
Expected: Clean install, no errors.

**Step 3: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "chore: add memory system dependencies (sqlite-vec, chokidar, sharp, pdfjs-dist, file-type)"
```

---

### Task 2: Port HTTP/fetch utilities (replace SSRF layer)

OpenClaw uses `remote-http.ts` (SSRF-protected fetch), `post-json.ts`, `embeddings-remote-fetch.ts`, `embeddings-remote-client.ts`, `embeddings-remote-provider.ts`. We port all of these but replace SSRF with plain `fetch`.

**Files:**
- Create: `src/memory/remote-http.ts`
- Create: `src/memory/post-json.ts`
- Create: `src/memory/embeddings-remote-fetch.ts`
- Create: `src/memory/embeddings-remote-client.ts`
- Create: `src/memory/embeddings-remote-provider.ts`

**Step 1: Create `remote-http.ts`** — simplified version without SSRF

Copy from `openclaw-source/src/memory/remote-http.ts`. Remove the `SsrFPolicy` import and `fetchWithSsrFGuard`. Replace with plain `fetch`:

```typescript
// src/memory/remote-http.ts
// Simplified from OpenClaw — no SSRF guard needed (local-only runtime)

export function buildRemoteBaseUrlPolicy(_baseUrl: string): undefined {
  return undefined;
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: unknown;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const response = await fetch(params.url, params.init);
  return await params.onResponse(response);
}
```

**Step 2: Copy `post-json.ts`** from OpenClaw

Copy `openclaw-source/src/memory/post-json.ts` verbatim. Change the `SsrFPolicy` import to:
```typescript
// Remove: import type { SsrFPolicy } from "../infra/net/ssrf.js";
// Keep ssrfPolicy param as `unknown` for interface compatibility
```

**Step 3: Copy `embeddings-remote-fetch.ts`** from OpenClaw

Copy verbatim, same `SsrFPolicy` → `unknown` adjustment.

**Step 4: Copy `embeddings-remote-client.ts`** from OpenClaw

This file imports from `../agents/model-auth.js` and `./secret-input.js`. These don't exist in OpenClaude. Simplify: resolve API key from config or environment variables directly.

```typescript
// src/memory/embeddings-remote-client.ts
// Simplified from OpenClaw — resolve API keys from config/env directly

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

const ENV_KEY_MAP: Record<RemoteEmbeddingProviderId, string[]> = {
  openai: ["OPENAI_API_KEY"],
  voyage: ["VOYAGE_API_KEY"],
  mistral: ["MISTRAL_API_KEY"],
};

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  remote?: { baseUrl?: string; apiKey?: string; headers?: Record<string, string> };
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const remote = params.remote;
  let apiKey = remote?.apiKey?.trim();
  if (!apiKey) {
    for (const envVar of ENV_KEY_MAP[params.provider] ?? []) {
      const val = process.env[envVar]?.trim();
      if (val) { apiKey = val; break; }
    }
  }
  if (!apiKey) {
    throw new Error(`No API key found for embedding provider "${params.provider}". Set it in config or via environment variable.`);
  }
  const baseUrl = remote?.baseUrl?.trim() || params.defaultBaseUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...remote?.headers,
  };
  return { baseUrl, headers };
}
```

**Step 5: Copy `embeddings-remote-provider.ts`** from OpenClaw

Copy verbatim, remove `SsrFPolicy` type references (replace with `unknown`).

**Step 6: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: All existing tests still pass (these new files aren't imported yet).

**Step 7: Commit**

```bash
git add src/memory/remote-http.ts src/memory/post-json.ts src/memory/embeddings-remote-fetch.ts src/memory/embeddings-remote-client.ts src/memory/embeddings-remote-provider.ts
git commit -m "feat(memory): port HTTP/fetch utilities from OpenClaw (no SSRF)"
```

---

### Task 3: Port SQLite wrapper and sqlite-vec extension loader

**Files:**
- Create: `src/memory/sqlite.ts`
- Create: `src/memory/sqlite-vec.ts`

**Step 1: Copy `sqlite.ts`** from `openclaw-source/src/memory/sqlite.ts`

Copy verbatim. This provides `requireNodeSqlite()` which lazy-loads `node:sqlite`.

**Step 2: Copy `sqlite-vec.ts`** from `openclaw-source/src/memory/sqlite-vec.ts`

Copy verbatim. This provides `loadSqliteVecExtension()`.

**Step 3: Write tests**

Create `src/memory/sqlite.test.ts`:
```typescript
import { describe, it, expect } from "vitest";
import { requireNodeSqlite } from "./sqlite.js";

describe("requireNodeSqlite", () => {
  it("returns the node:sqlite module", () => {
    const mod = requireNodeSqlite();
    expect(mod).toBeDefined();
    expect(mod.DatabaseSync).toBeDefined();
  });
});
```

**Step 4: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/sqlite.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/sqlite.ts src/memory/sqlite-vec.ts src/memory/sqlite.test.ts
git commit -m "feat(memory): port SQLite wrapper and sqlite-vec loader from OpenClaw"
```

---

### Task 4: Replace schema with OpenClaw's version

**Files:**
- Modify: `src/memory/schema.ts`
- Modify: `src/memory/schema.test.ts`

**Step 1: Replace `schema.ts`**

Copy `openclaw-source/src/memory/memory-schema.ts` content into `src/memory/schema.ts`. This adds:
- Parameterized table names (`embeddingCacheTable`, `ftsTable`)
- Conditional FTS creation (`ftsEnabled` param)
- `ensureColumn()` helper for backward compat
- Will later support `chunks_vec` creation (when sqlite-vec is available)

Keep the export name as `ensureMemorySchema` but update the signature to match OpenClaw's `ensureMemoryIndexSchema`.

**Step 2: Update tests**

Update `src/memory/schema.test.ts` to match new function signature. Verify:
- Schema creates all tables (meta, files, chunks, embedding_cache, chunks_fts)
- FTS can be disabled via `ftsEnabled: false`
- Idempotent (can be called twice)

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/schema.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/schema.ts src/memory/schema.test.ts
git commit -m "feat(memory): replace schema with OpenClaw's parameterized version"
```

---

### Task 5: Port embedding vector utilities

**Files:**
- Create: `src/memory/embedding-vectors.ts`
- Create: `src/memory/embedding-input-limits.ts`
- Create: `src/memory/embedding-chunk-limits.ts`
- Create: `src/memory/embedding-model-limits.ts`

**Step 1: Copy all four files** from `openclaw-source/src/memory/`

Copy verbatim:
- `embedding-vectors.ts` (9 lines) — `sanitizeAndNormalizeEmbedding()`
- `embedding-input-limits.ts` (86 lines) — UTF-8 byte estimation, text splitting
- `embedding-chunk-limits.ts` (42 lines) — enforce max input tokens per provider
- `embedding-model-limits.ts` (42 lines) — known limits per provider:model

For `embedding-chunk-limits.ts`, check if it imports from types that don't exist yet. If so, create minimal type stubs or adjust imports.

**Step 2: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: All tests pass

**Step 3: Commit**

```bash
git add src/memory/embedding-vectors.ts src/memory/embedding-input-limits.ts src/memory/embedding-chunk-limits.ts src/memory/embedding-model-limits.ts
git commit -m "feat(memory): port embedding vector/limit utilities from OpenClaw"
```

---

### Task 6: Port embedding providers

**Files:**
- Create: `src/memory/embeddings.ts`
- Create: `src/memory/embeddings-openai.ts`
- Create: `src/memory/embeddings-gemini.ts`
- Create: `src/memory/embeddings-voyage.ts`
- Create: `src/memory/embeddings-mistral.ts`
- Create: `src/memory/embeddings-ollama.ts`

**Step 1: Copy `embeddings.ts`** from OpenClaw

This is the main factory. Copy and adapt:
- Remove `importNodeLlamaCpp` import and local provider path (we excluded node-llama-cpp)
- Remove the `"local"` provider case from the factory
- Keep `"auto"` detection that tries providers in order
- Update `EmbeddingProviderOptions` to work with OpenClaude's config shape (flat config instead of agent-scoped)

**Step 2: Copy provider files**

Copy each provider file from OpenClaw, making these adaptations:
- Replace `import type { SsrFPolicy }` with removal (not needed)
- Replace `import { normalizeEmbeddingModelWithPrefixes }` with inline identity function or simple passthrough (we excluded model-normalize)
- Update imports to use local `./embeddings-remote-client.js` and `./embeddings-remote-provider.js`

For each provider:
- `embeddings-openai.ts` — POST to `/v1/embeddings`, uses remote-provider pattern
- `embeddings-gemini.ts` — Gemini API, custom auth (API key in URL), task types. This is the most complex (333 lines). Copy carefully, remove SSRF references.
- `embeddings-voyage.ts` — POST to Voyage API, uses remote-provider pattern
- `embeddings-mistral.ts` — POST to Mistral API, uses remote-provider pattern
- `embeddings-ollama.ts` — POST to local Ollama server. Remove SSRF. Update auth resolution to use env vars directly (`OLLAMA_API_KEY`, `OLLAMA_BASE_URL`).

**Step 3: Update `embeddings.test.ts`**

Replace the stub test with real tests:
- Test factory creates providers for each type (mock the HTTP calls)
- Test fallback chain (primary fails → falls back)
- Test FTS-only degradation (no API keys → returns null)

**Step 4: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/embeddings.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/memory/embeddings.ts src/memory/embeddings-openai.ts src/memory/embeddings-gemini.ts src/memory/embeddings-voyage.ts src/memory/embeddings-mistral.ts src/memory/embeddings-ollama.ts src/memory/embeddings.test.ts
git commit -m "feat(memory): port all 5 embedding providers from OpenClaw"
```

---

### Task 7: Expand config schema for memory

**Files:**
- Modify: `src/config/schema.ts`
- Modify: `src/config/types.ts`

**Step 1: Expand `MemorySchema`** in `src/config/schema.ts`

Replace the minimal schema with full config matching OpenClaw's `MemorySearchConfig`:

```typescript
export const MemorySchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default("~/.openclaude/memory/openclaude.sqlite"),
  sources: z.array(z.enum(["memory", "sessions"])).default(["memory"]),
  extraPaths: z.array(z.string()).default([]),
  provider: z.enum(["openai", "gemini", "voyage", "mistral", "ollama", "none"]).default("none"),
  model: z.string().optional(),
  outputDimensionality: z.number().optional(),
  remote: z.object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
    batch: z.object({
      enabled: z.boolean().default(true),
      wait: z.boolean().default(true),
      concurrency: z.number().default(2),
      pollIntervalMs: z.number().default(5000),
      timeoutMinutes: z.number().default(60),
    }).default({}),
  }).default({}),
  fallback: z.enum(["openai", "gemini", "voyage", "mistral", "ollama", "none"]).default("none"),
  store: z.object({
    driver: z.literal("sqlite").default("sqlite"),
    path: z.string().optional(),
    vector: z.object({
      enabled: z.boolean().default(true),
      extensionPath: z.string().optional(),
    }).default({}),
  }).default({}),
  chunking: z.object({
    tokens: z.number().default(400),
    overlap: z.number().default(80),
  }).default({}),
  sync: z.object({
    onSessionStart: z.boolean().default(true),
    onSearch: z.boolean().default(true),
    watch: z.boolean().default(false),
    watchDebounceMs: z.number().default(500),
    intervalMinutes: z.number().default(5),
  }).default({}),
  query: z.object({
    maxResults: z.number().default(6),
    minScore: z.number().default(0.35),
    hybrid: z.object({
      enabled: z.boolean().default(true),
      vectorWeight: z.number().default(0.7),
      textWeight: z.number().default(0.3),
      candidateMultiplier: z.number().default(4),
      mmr: z.object({
        enabled: z.boolean().default(false),
        lambda: z.number().default(0.7),
      }).default({}),
      temporalDecay: z.object({
        enabled: z.boolean().default(false),
        halfLifeDays: z.number().default(30),
      }).default({}),
    }).default({}),
  }).default({}),
  cache: z.object({
    enabled: z.boolean().default(true),
    maxEntries: z.number().optional(),
  }).default({}),
  multimodal: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
});
```

**Step 2: Update `MemoryConfig`** in `src/config/types.ts`

Replace the minimal interface with `z.infer<typeof MemorySchema>` or manually expand to match.

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose`
Expected: All tests pass. Existing configs with `memory: { dbPath }` still validate (all new fields have defaults).

**Step 4: Commit**

```bash
git add src/config/schema.ts src/config/types.ts
git commit -m "feat(config): expand memory schema with full embedding/search/sync config"
```

---

## Phase 2: Core Search — Manager Split, Query, Ranking

### Task 8: Replace query-expansion with OpenClaw's multilingual version

**Files:**
- Modify: `src/memory/query-expansion.ts`
- Modify: `src/memory/query-expansion.test.ts` (if exists, otherwise port from OpenClaw)

**Step 1: Replace `query-expansion.ts`**

Copy `openclaw-source/src/memory/query-expansion.ts` (811 lines) verbatim. This adds:
- 7-language stop word lists (EN, ES, PT, AR, KO, JA, ZH)
- CJK tokenization (Chinese bigrams, Korean particle stripping, Japanese script splitting)
- `expandQueryForFts()` and `expandQueryWithLlm()` functions
- Proper `isQueryStopWordToken()` across all languages

**Step 2: Port tests**

Copy `openclaw-source/src/memory/query-expansion.test.ts` (199 lines).

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/query-expansion.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/query-expansion.ts src/memory/query-expansion.test.ts
git commit -m "feat(memory): replace query expansion with OpenClaw's multilingual version"
```

---

### Task 9: Replace hybrid, MMR, temporal-decay with OpenClaw's versions

**Files:**
- Modify: `src/memory/hybrid.ts`
- Modify: `src/memory/mmr.ts`
- Modify: `src/memory/temporal-decay.ts`
- Modify: `src/memory/hybrid.test.ts`
- Modify: `src/memory/mmr.test.ts`
- Modify: `src/memory/temporal-decay.test.ts`

**Step 1: Replace `mmr.ts`**

Copy `openclaw-source/src/memory/mmr.ts` (215 lines). This adds:
- Generic `mmrRerank()` + specialized `applyMMRToHybridResults()` adapter
- Lambda clamping (`Math.max(0, Math.min(1, lambda))`)
- Tiebreaker logic
- Early exit for `lambda === 1`

**Step 2: Replace `temporal-decay.ts`**

Copy `openclaw-source/src/memory/temporal-decay.ts` (168 lines). This adds:
- Promise-cached async with deduplication
- UTC-validated date parsing
- Source-aware evergreen detection
- Isolated helper functions

**Step 3: Replace `hybrid.ts`**

Copy `openclaw-source/src/memory/hybrid.ts` (156 lines). This fixes:
- Snippet selection by length check (not score)
- `.toSorted()` (immutable)
- Quote escaping in FTS queries
- `!Number.isFinite()` guard in bm25RankToScore

**Step 4: Port tests**

Copy test files from OpenClaw:
- `openclaw-source/src/memory/mmr.test.ts` (390 lines)
- `openclaw-source/src/memory/temporal-decay.test.ts` (173 lines)
- `openclaw-source/src/memory/hybrid.test.ts` (98 lines)

**Step 5: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/mmr.test.ts src/memory/temporal-decay.test.ts src/memory/hybrid.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/memory/hybrid.ts src/memory/mmr.ts src/memory/temporal-decay.ts src/memory/hybrid.test.ts src/memory/mmr.test.ts src/memory/temporal-decay.test.ts
git commit -m "feat(memory): replace hybrid/MMR/temporal-decay with OpenClaw's hardened versions"
```

---

### Task 10: Port internal.ts updates and utility files

**Files:**
- Modify: `src/memory/internal.ts`
- Create: `src/memory/fs-utils.ts`
- Create: `src/memory/multimodal.ts`
- Modify: `src/memory/internal.test.ts`

**Step 1: Copy `fs-utils.ts`** from OpenClaw (32 lines)

Copy verbatim. Provides `statRegularFile()` and `isFileMissingError()`.

**Step 2: Copy `multimodal.ts`** from OpenClaw (100 lines)

Copy verbatim. Provides multimodal file classification (image/audio extensions, max file bytes).

**Step 3: Replace `internal.ts`**

Copy `openclaw-source/src/memory/internal.ts` (~700 lines). This adds:
- Multimodal file detection and `MemoryFileEntry.kind`/`modality`/`mimeType`
- Extra memory paths support (`normalizeExtraMemoryPaths()`)
- `walkDir()` with multimodal settings
- `buildMultimodalChunkForIndexing()`
- More robust `isMemoryPath()`

**Step 4: Port tests**

Copy `openclaw-source/src/memory/internal.test.ts` (314 lines).

**Step 5: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/internal.test.ts`
Expected: PASS

**Step 6: Commit**

```bash
git add src/memory/internal.ts src/memory/fs-utils.ts src/memory/multimodal.ts src/memory/internal.test.ts
git commit -m "feat(memory): port internal utilities with multimodal and extra paths support"
```

---

### Task 11: Port types.ts from OpenClaw

**Files:**
- Modify: `src/memory/types.ts`

**Step 1: Replace `types.ts`**

Copy `openclaw-source/src/memory/types.ts` (82 lines). This adds:
- `MemorySearchManager` interface (with optional `sync?`, `close?`)
- Extended `MemoryProviderStatus` with backend, fallback, batch, sources, vector dims
- `MemoryEmbeddingProbeResult`
- `MemorySyncProgressUpdate`

Keep backward compatibility: ensure `MemorySearchResult`, `MemorySource`, `MemoryChunk` types still exist.

**Step 2: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: PASS (type changes may cause compilation errors in downstream files — fix imports)

**Step 3: Commit**

```bash
git add src/memory/types.ts
git commit -m "feat(memory): expand types to match OpenClaw's full status/probe types"
```

---

### Task 12: Port manager split (core + search + embedding ops + sync ops)

This is the biggest task. OpenClaw splits the manager into 4 files with a class hierarchy.

**Files:**
- Modify: `src/memory/manager.ts` → rewrite as `MemoryIndexManager`
- Create: `src/memory/manager-search.ts`
- Create: `src/memory/manager-embedding-ops.ts`
- Create: `src/memory/manager-sync-ops.ts`
- Create: `src/memory/status-format.ts`
- Modify: `src/memory/index.ts`
- Modify: `src/memory/manager.test.ts`

**Step 1: Copy `manager-search.ts`** from OpenClaw (192 lines)

Copy verbatim. Provides `searchVector()`, `searchKeyword()`, `listChunks()`.

**Step 2: Copy `manager-sync-ops.ts`** from OpenClaw

Copy and adapt:
- Remove chokidar-specific session file watching (port session files separately in Phase 3)
- Keep core sync logic: file discovery, hash comparison, chunk insertion/deletion
- Keep sqlite-vec loading with timeout
- Update config references to use OpenClaude's flat config

**Step 3: Copy `manager-embedding-ops.ts`** from OpenClaw (927 lines)

Copy and adapt:
- Remove node-llama-cpp references
- Keep batch embedding logic, retry with backoff
- Keep embedding cache operations
- Update config references

**Step 4: Rewrite `manager.ts`** as `MemoryIndexManager`

Copy OpenClaw's `manager.ts` (841 lines) structure:
- `MemoryIndexManager extends MemoryManagerEmbeddingOps`
- Static `get()` factory with `INDEX_CACHE`
- `search()` with hybrid vector+FTS flow
- `sync()`, `readFile()`, `status()`, `probeVectorAvailability()`, `probeEmbeddingAvailability()`
- Adapt config resolution: instead of `ResolvedMemorySearchConfig` from agent scope, read from OpenClaude's `MemoryConfig`

**Step 5: Copy `status-format.ts`** from OpenClaw (46 lines)

Copy verbatim.

**Step 6: Update `index.ts`**

Update exports to match new API:
```typescript
export { MemoryIndexManager } from "./manager.js";
export type { MemorySearchManager, MemorySearchResult, MemoryProviderStatus, MemorySource } from "./types.js";
```

**Step 7: Port/update manager tests**

Port `openclaw-source/src/memory/index.test.ts` (1114 lines) and adapt to OpenClaude's config. Also port:
- `manager.read-file.test.ts` (124 lines)
- `manager.sync-errors-do-not-crash.test.ts` (75 lines)
- `manager.vector-dedupe.test.ts` (110 lines)
- `manager.readonly-recovery.test.ts` (122 lines)

Create `src/memory/test-runtime-mocks.ts` from OpenClaw's version (mocks chokidar and sqlite-vec for unit tests).

**Step 8: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: PASS

**Step 9: Commit**

```bash
git add src/memory/manager.ts src/memory/manager-search.ts src/memory/manager-embedding-ops.ts src/memory/manager-sync-ops.ts src/memory/status-format.ts src/memory/index.ts src/memory/test-runtime-mocks.ts src/memory/manager.test.ts
git commit -m "feat(memory): port manager split from OpenClaw (search, embedding ops, sync ops)"
```

---

### Task 13: Port backend-config and search-manager factory

**Files:**
- Create: `src/memory/backend-config.ts`
- Create: `src/memory/search-manager.ts`

**Step 1: Create `backend-config.ts`**

Simplified from OpenClaw's version (355 lines). We only support the "builtin" backend (no QMD), so this becomes a config resolver that maps OpenClaude's flat `MemoryConfig` to the internal `ResolvedMemorySearchConfig` shape the manager expects.

**Step 2: Create `search-manager.ts`**

Simplified from OpenClaw's version (254 lines). No QMD fallback — just creates and caches `MemoryIndexManager` instances. Provides:
- `getMemorySearchManager()` — entry point
- `closeAllMemorySearchManagers()` — cleanup

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/backend-config.ts src/memory/search-manager.ts
git commit -m "feat(memory): port backend config resolution and search manager factory"
```

---

## Phase 3: Advanced Features — Batch, Multimodal, Sessions

### Task 14: Port batch embedding pipeline

**Files:**
- Create: `src/memory/batch-runner.ts`
- Create: `src/memory/batch-utils.ts`
- Create: `src/memory/batch-http.ts`
- Create: `src/memory/batch-upload.ts`
- Create: `src/memory/batch-output.ts`
- Create: `src/memory/batch-status.ts`
- Create: `src/memory/batch-error-utils.ts`
- Create: `src/memory/batch-provider-common.ts`
- Create: `src/memory/batch-embedding-common.ts`
- Create: `src/memory/batch-openai.ts`
- Create: `src/memory/batch-gemini.ts`
- Create: `src/memory/batch-voyage.ts`

**Step 1: Copy utility files** from OpenClaw

Copy verbatim (these are standalone):
- `batch-runner.ts` (65 lines)
- `batch-utils.ts` (39 lines) — remove `SsrFPolicy` type, use `unknown`
- `batch-output.ts` (56 lines)
- `batch-status.ts` (70 lines)
- `batch-error-utils.ts` (32 lines)
- `batch-provider-common.ts` (13 lines)

**Step 2: Copy HTTP/upload files**

- `batch-http.ts` (35 lines) — adapt: remove `SsrFPolicy` import, remove `retryAsync` import (inline simple retry or import from a local utility), use local `post-json.js`
- `batch-upload.ts` (45 lines) — adapt: update imports

**Step 3: Copy `batch-embedding-common.ts`** (23 lines)

This is the re-export hub. Copy and update import paths. Remove `withRemoteHttpResponse` re-export if not needed from this hub.

**Step 4: Copy provider batch files**

- `batch-openai.ts` (260 lines) — copy, update imports
- `batch-gemini.ts` (369 lines) — copy, update imports, remove SSRF
- `batch-voyage.ts` (286 lines) — copy, update imports

**Step 5: Port batch tests**

Copy from OpenClaw:
- `batch-output.test.ts` (82 lines)
- `batch-http.test.ts` (78 lines)
- `batch-status.test.ts` (60 lines)
- `batch-error-utils.test.ts` (32 lines)
- `batch-gemini.test.ts` (102 lines)
- `batch-voyage.test.ts` (176 lines)

**Step 6: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/batch-*.test.ts`
Expected: PASS

**Step 7: Commit**

```bash
git add src/memory/batch-*.ts
git commit -m "feat(memory): port batch embedding pipeline from OpenClaw (OpenAI, Gemini, Voyage)"
```

---

### Task 15: Port session file tracking

**Files:**
- Create: `src/memory/session-files.ts`
- Port: `src/memory/session-files.test.ts`

**Step 1: Copy `session-files.ts`** from OpenClaw

Copy and adapt:
- Update session transcript path to use `~/.openclaude/sessions/` instead of OpenClaw's path
- Keep JSONL parsing, line mapping, text extraction logic

**Step 2: Port tests**

Copy `openclaw-source/src/memory/session-files.test.ts` (87 lines).

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/session-files.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/session-files.ts src/memory/session-files.test.ts
git commit -m "feat(memory): port session file tracking from OpenClaw"
```

---

### Task 16: Port file watcher integration

**Files:**
- Modify: `src/memory/manager-sync-ops.ts` (add chokidar watcher setup)

**Step 1: Add watcher logic**

If not already included in Task 12, add the chokidar file watcher to `manager-sync-ops.ts`:
- Watch `memory/` directory for changes
- Debounce re-indexing (configurable via `sync.watchDebounceMs`)
- Clean up watcher on `close()`

**Step 2: Port watcher tests**

Copy `openclaw-source/src/memory/manager.watcher-config.test.ts` (155 lines).

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose src/memory/`
Expected: PASS

**Step 4: Commit**

```bash
git add src/memory/manager-sync-ops.ts src/memory/manager.watcher-config.test.ts
git commit -m "feat(memory): add chokidar file watcher for live re-indexing"
```

---

## Phase 4: Integration & Verification

### Task 17: Update gateway integration

**Files:**
- Modify: `src/gateway/lifecycle.ts`
- Modify: `src/gateway/http.ts`

**Step 1: Update `lifecycle.ts`**

Replace `createMemoryManager()` call with `getMemorySearchManager()` or `MemoryIndexManager.get()`. Pass full memory config from validated config. Update shutdown to use `closeAllMemorySearchManagers()`.

**Step 2: Update `http.ts`**

Update type imports. If the `MemoryManager` interface changed, update the HTTP handler parameter types.

**Step 3: Run tests**

Run: `pnpm test -- --reporter=verbose`
Expected: PASS

**Step 4: Commit**

```bash
git add src/gateway/lifecycle.ts src/gateway/http.ts
git commit -m "feat(gateway): update memory integration to use new manager"
```

---

### Task 18: Update router and tools

**Files:**
- Modify: `src/router/commands.ts`
- Modify: `src/router/router.ts`
- Modify: `src/tools/memory-tools.ts`

**Step 1: Update `commands.ts`**

Update `/memory` command to show richer status (provider info, vector state, embedding availability).

**Step 2: Update `router.ts`**

Update memory flush imports if the interface changed.

**Step 3: Update `memory-tools.ts`**

Update type imports for `MemorySearchResult` if shape changed.

**Step 4: Run tests**

Run: `pnpm test -- --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/router/commands.ts src/router/router.ts src/tools/memory-tools.ts
git commit -m "feat(router,tools): update memory integration for new manager API"
```

---

### Task 19: Port remaining tests from OpenClaw

**Files:**
- Port remaining test files that haven't been covered

**Step 1: Port these test files** from OpenClaw (adapt as needed):

- `manager.batch.test.ts` (321 lines)
- `manager.embedding-batches.test.ts` (141 lines)
- `manager.async-search.test.ts` (104 lines)
- `manager.atomic-reindex.test.ts` (86 lines)
- `manager.get-concurrency.test.ts` (118 lines)
- `manager.mistral-provider.test.ts` (196 lines)
- `embeddings-gemini.test.ts` (609 lines)
- `embeddings-ollama.test.ts` (129 lines)
- `embeddings-voyage.test.ts` (152 lines)
- `embeddings-mistral.test.ts` (19 lines)
- `search-manager.test.ts` (279 lines)
- `backend-config.test.ts` (146 lines)

Create `test-embeddings-mock.ts` and `test-manager-helpers.ts` from OpenClaw.

**Step 2: Run full test suite**

Run: `pnpm test -- --reporter=verbose`
Expected: ALL PASS

**Step 3: Commit**

```bash
git add src/memory/*.test.ts src/memory/test-*.ts
git commit -m "test(memory): port remaining tests from OpenClaw"
```

---

### Task 20: Full verification

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Run linter**

Run: `pnpm lint`
Expected: Clean (or only pre-existing warnings)

**Step 3: Run build**

Run: `pnpm build`
Expected: Clean build, no type errors

**Step 4: Test backward compatibility**

Verify that a minimal config `{ "memory": { "dbPath": "..." } }` still works (all new fields use defaults).

**Step 5: Final commit if any cleanup needed**

```bash
git add -A
git commit -m "chore(memory): final cleanup after OpenClaw memory port"
```

---

## File Inventory

### New files to create (~45)
```
src/memory/sqlite.ts
src/memory/sqlite-vec.ts
src/memory/remote-http.ts
src/memory/post-json.ts
src/memory/embeddings-remote-fetch.ts
src/memory/embeddings-remote-client.ts
src/memory/embeddings-remote-provider.ts
src/memory/embedding-vectors.ts
src/memory/embedding-input-limits.ts
src/memory/embedding-chunk-limits.ts
src/memory/embedding-model-limits.ts
src/memory/embeddings.ts
src/memory/embeddings-openai.ts
src/memory/embeddings-gemini.ts
src/memory/embeddings-voyage.ts
src/memory/embeddings-mistral.ts
src/memory/embeddings-ollama.ts
src/memory/manager-search.ts
src/memory/manager-embedding-ops.ts
src/memory/manager-sync-ops.ts
src/memory/backend-config.ts
src/memory/search-manager.ts
src/memory/status-format.ts
src/memory/fs-utils.ts
src/memory/multimodal.ts
src/memory/session-files.ts
src/memory/batch-runner.ts
src/memory/batch-utils.ts
src/memory/batch-http.ts
src/memory/batch-upload.ts
src/memory/batch-output.ts
src/memory/batch-status.ts
src/memory/batch-error-utils.ts
src/memory/batch-provider-common.ts
src/memory/batch-embedding-common.ts
src/memory/batch-openai.ts
src/memory/batch-gemini.ts
src/memory/batch-voyage.ts
src/memory/test-runtime-mocks.ts
src/memory/test-embeddings-mock.ts
src/memory/test-manager-helpers.ts
src/memory/sqlite.test.ts
src/memory/session-files.test.ts
+ ~12 ported test files
```

### Existing files to modify (~12)
```
package.json
src/config/schema.ts
src/config/types.ts
src/memory/schema.ts
src/memory/types.ts
src/memory/internal.ts
src/memory/query-expansion.ts
src/memory/hybrid.ts
src/memory/mmr.ts
src/memory/temporal-decay.ts
src/memory/manager.ts
src/memory/index.ts
src/gateway/lifecycle.ts
src/gateway/http.ts
src/router/commands.ts
src/router/router.ts
src/tools/memory-tools.ts
```
