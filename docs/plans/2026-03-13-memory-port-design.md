# Memory System Port: OpenClaw → OpenClaude

**Date:** 2026-03-13
**Status:** Approved
**Scope:** Replace OpenClaude's FTS-only memory system with OpenClaw's full implementation

## Problem

OpenClaude's memory system is a stripped-down MVP with keyword search only (FTS5). It lacks semantic/vector search, embedding providers, file watching, multimodal support, batch processing, and multilingual query handling. OpenClaw's upstream implementation has all of these. We need feature parity.

## Current State

**OpenClaude memory (10 files, ~1.1k LOC):**
- FTS5 keyword search only
- No embedding providers
- No vector search
- English-only stop words (72 words)
- No file watcher
- No multimodal support
- Monolithic `manager.ts`
- Simplified MMR, temporal decay, hybrid merge (missing edge case handling)
- Config: `memory: { dbPath }` — one field

**OpenClaw memory (100+ files, ~21k LOC):**
- Hybrid vector + FTS search
- 5 embedding providers (OpenAI, Gemini, Voyage, Mistral, Ollama)
- sqlite-vec native vector search with in-memory fallback
- 7-language stop words with CJK tokenization
- chokidar file watcher for live re-indexing
- Multimodal (images, PDF, audio) via sharp + pdfjs-dist
- Split manager (search, embedding ops, sync ops)
- Batch embedding APIs (OpenAI, Gemini, Voyage)
- Session file tracking
- Full config with 40+ options

## Decision

Port OpenClaw's memory system to OpenClaude. Copy files directly and adapt only where the config/runtime systems differ.

### In Scope

| Feature | OpenClaw Source Files | Notes |
|---------|----------------------|-------|
| Embedding abstraction | `embeddings.ts` | Provider factory + `EmbeddingProvider` interface |
| OpenAI provider | `embeddings-openai.ts` | text-embedding-3-small/large |
| Gemini provider | `embeddings-gemini.ts` | gemini-embedding-001, text-embedding-004 |
| Voyage provider | `embeddings-voyage.ts` | voyage-3, voyage-code-3 |
| Mistral provider | `embeddings-mistral.ts` | mistral-embed |
| Ollama provider | `embeddings-ollama.ts` | Local, any model |
| Embedding limits | `embedding-input-limits.ts`, `embedding-chunk-limits.ts`, `embedding-model-limits.ts` | Per-model token/char limits |
| Embedding vectors | `embedding-vectors.ts` | Vector storage/retrieval helpers |
| sqlite-vec | `sqlite-vec.ts` | Native vector extension loading |
| SQLite wrapper | `sqlite.ts` | `requireNodeSqlite()` |
| Schema | `memory-schema.ts` | `chunks_vec` virtual table, parameterized names, conditional FTS |
| Manager (core) | `manager.ts` | `MemoryIndexManager` class |
| Manager (search) | `manager-search.ts` | `searchVector()`, `searchKeyword()` |
| Manager (embeddings) | `manager-embedding-ops.ts` | Embedding operation methods |
| Manager (sync) | `manager-sync-ops.ts` | File watching, sync operations |
| Search manager factory | `search-manager.ts` | Backend selection, initialization |
| Backend config | `backend-config.ts` | Config resolution |
| Query expansion | `query-expansion.ts` | 7-language stop words, CJK tokenization |
| Hybrid merge | `hybrid.ts` | Fixed snippet selection, `.toSorted()`, quote escaping, infinity guard |
| MMR | `mmr.ts` | Generic + adapter, lambda clamping, tiebreakers |
| Temporal decay | `temporal-decay.ts` | Promise-cached, UTC validation, source-aware |
| File discovery | `internal.ts` | Multimodal detection, extra paths |
| Multimodal | `multimodal.ts` | Image/PDF/audio chunking |
| Batch runner | `batch-runner.ts` | Batch job orchestration |
| Batch providers | `batch-openai.ts`, `batch-gemini.ts`, `batch-voyage.ts` | Provider-specific batch APIs |
| Batch support | `batch-http.ts`, `batch-upload.ts`, `batch-output.ts`, `batch-status.ts`, `batch-error-utils.ts`, `batch-provider-common.ts`, `batch-embedding-common.ts` | Shared batch infrastructure |
| Session files | `session-files.ts` | Session transcript indexing |
| FS utilities | `fs-utils.ts` | File stat caching |
| Status formatting | `status-format.ts` | Status output helpers |
| Readonly recovery | Manager readonly recovery logic | DB resilience |
| Config types | Memory config types from OpenClaw | Full `ResolvedMemorySearchConfig` equivalent |
| Tests | All corresponding test files | Port and adapt |

### Out of Scope

| Feature | Files | Reason |
|---------|-------|--------|
| QMD backend | `qmd-manager.ts`, `qmd-process.ts`, `qmd-query-parser.ts`, `qmd-scope.ts` | Alternative query engine, enterprise-only, not needed |
| node-llama-cpp | `node-llama.ts` | Heavy native dep, Ollama covers local use case |
| SSRF protection | `remote-http.ts`, `embeddings-remote-*.ts` | OpenClaude runs locally, not exposed to untrusted input |
| Model normalization | `embeddings-model-normalize.ts` | Legacy alias handling, fresh start |

## Architecture

### Config Changes

Extend `MemoryConfig` / `MemorySchema` to carry all fields from OpenClaw's `ResolvedMemorySearchConfig`:

```typescript
interface MemoryConfig {
  dbPath: string;
  enabled: boolean;
  sources: Array<"memory" | "sessions">;
  extraPaths: string[];

  // Embedding provider
  provider: "openai" | "gemini" | "voyage" | "mistral" | "ollama" | "none";
  model?: string;
  outputDimensionality?: number;
  remote?: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch?: { enabled: boolean; wait: number; concurrency: number; pollIntervalMs: number; timeoutMinutes: number };
  };
  fallback?: "openai" | "gemini" | "voyage" | "mistral" | "ollama" | "none";

  // Storage
  store: {
    driver: "sqlite";
    path: string;
    vector: { enabled: boolean; extensionPath?: string };
  };

  // Processing
  chunking: { tokens: number; overlap: number };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
  };

  // Query
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: { enabled: boolean; lambda: number };
      temporalDecay: { enabled: boolean; halfLifeDays: number };
    };
  };

  // Cache
  cache: { enabled: boolean; maxEntries?: number };

  // Multimodal
  multimodal?: { enabled: boolean };
}
```

All new fields have sensible defaults. Existing `memory: { dbPath }` configs continue to work.

### Manager Split

Replace monolithic `manager.ts` with OpenClaw's split:

```
manager.ts              — Core MemoryIndexManager class, lifecycle
manager-search.ts       — searchVector(), searchKeyword(), listChunks()
manager-embedding-ops.ts — embed operations, provider management
manager-sync-ops.ts     — file watcher, sync, sqlite-vec loading
```

### Search Flow (After Port)

```
User Query
    ↓
MemoryIndexManager.search(query, opts)
    ↓
IF embedding provider configured:
    embedQuery(query) → number[]
    searchVector(embedding) → vector results
    IF hybrid enabled & FTS available:
        searchKeyword(query) → FTS results
        mergeHybridResults(vector, keyword, weights, mmr, decay)
    ELSE: return vector results
ELSE (FTS-only fallback):
    extractKeywords(query) → tokens
    searchKeyword(tokens) → FTS results
    ↓
Filter by minScore → return top maxResults
```

### Dependencies to Add

```json
{
  "sqlite-vec": "0.1.7-alpha.2",
  "chokidar": "^5.0.0",
  "sharp": "^0.34.5",
  "pdfjs-dist": "^5.5.207",
  "file-type": "^21.3.1"
}
```

### Integration Points to Update

| File | Change |
|------|--------|
| `src/config/schema.ts` | Expand `MemorySchema` with all new fields + defaults |
| `src/config/types.ts` | Expand `MemoryConfig` interface |
| `src/gateway/lifecycle.ts` | Use new manager factory, pass full config |
| `src/gateway/http.ts` | Update type imports if needed |
| `src/router/commands.ts` | Update `/memory` status output for richer status |
| `src/tools/memory-tools.ts` | Update if type shapes change |

## Phases (Sequential)

### Phase 1 — Foundation
1. Add npm dependencies
2. Port `sqlite.ts`, `sqlite-vec.ts`
3. Replace `memory-schema.ts` with OpenClaw's version (adds `chunks_vec`)
4. Port embedding provider abstraction (`embeddings.ts`)
5. Port all 5 providers + limit files + vector helpers
6. Expand config schema
7. Tests green

### Phase 2 — Core Search
8. Port manager split (`manager.ts`, `manager-search.ts`, `manager-embedding-ops.ts`, `manager-sync-ops.ts`)
9. Replace `query-expansion.ts`, `hybrid.ts`, `mmr.ts`, `temporal-decay.ts` with OpenClaw's
10. Port `internal.ts` updates (multimodal detection, extra paths, multilingual)
11. Port file watcher (chokidar in `manager-sync-ops.ts`)
12. Port `backend-config.ts`, `search-manager.ts`
13. Tests green

### Phase 3 — Advanced Features
14. Port batch embedding pipeline (all `batch-*.ts` files)
15. Port multimodal support (`multimodal.ts`)
16. Port session file tracking (`session-files.ts`, `fs-utils.ts`)
17. Port `status-format.ts`, readonly recovery
18. Tests green

### Phase 4 — Integration & Verification
19. Update all integration points (gateway, router, HTTP, tools, config)
20. Port/update all tests from OpenClaw
21. Full test suite green, lint clean, build passes
22. Verify existing SQLite DBs migrate (additive schema only)

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| sqlite-vec fails to load on node:sqlite | No vector search | In-memory cosine fallback (OpenClaw already has this) |
| sharp install fails (native dep) | No multimodal | Multimodal is optional; text memory still works |
| Config migration breaks existing setups | Broken startup | All new fields have defaults; old configs unchanged |
| Test count explosion (~40+ new test files) | Slow CI | Run targeted tests per phase, full suite at Phase 4 |

## Definition of Done

- All OpenClaw memory features (except QMD, node-llama, SSRF, model-normalize) work in OpenClaude
- `pnpm test` green
- `pnpm lint` clean
- `pnpm build` passes
- Existing `config.json` with `memory: { dbPath }` still works (backward compatible)
- Existing SQLite databases migrate seamlessly (additive schema changes only)
