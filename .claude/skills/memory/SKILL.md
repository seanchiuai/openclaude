---
name: memory
description: Hybrid vector + keyword search with SQLite FTS5, sqlite-vec, 5 embedding providers, batch APIs, multimodal
---

# Memory - Hybrid Search System

Two-layer memory system: markdown files as source of truth, SQLite FTS5 + sqlite-vec as search index. Supports 5 embedding providers (OpenAI, Gemini, Voyage, Mistral, Ollama), batch embedding APIs, multimodal file indexing, and 7-language query expansion.

## When to Use This Skill

- Modifying search scoring or ranking
- Working with embedding providers
- Changing markdown chunking behavior
- Adding new memory operations
- Debugging search quality issues
- Configuring vector search or batch embedding

## Key Files

### Manager (class hierarchy)
- `src/memory/manager.ts` — `MemoryIndexManager` (top-level, search + readFile + status)
- `src/memory/manager-embedding-ops.ts` — Embedding batch operations, cache, retry
- `src/memory/manager-sync-ops.ts` — File sync, schema, sqlite-vec loading, chokidar watcher
- `src/memory/manager-search.ts` — Standalone `searchVector()`, `searchKeyword()`, `listChunks()`
- `src/memory/search-manager.ts` — Factory: `getMemorySearchManager()`, lifecycle
- `src/memory/backend-config.ts` — Config resolution

### Embedding Providers
- `src/memory/embeddings.ts` — Factory + `EmbeddingProvider` interface + auto-selection
- `src/memory/embeddings-openai.ts` — OpenAI (text-embedding-3-small/large)
- `src/memory/embeddings-gemini.ts` — Gemini (gemini-embedding-001, text-embedding-004)
- `src/memory/embeddings-voyage.ts` — Voyage (voyage-3, voyage-code-3)
- `src/memory/embeddings-mistral.ts` — Mistral (mistral-embed)
- `src/memory/embeddings-ollama.ts` — Ollama (nomic-embed-text, local)

### Batch Embedding
- `src/memory/batch-runner.ts` — Orchestration with concurrency
- `src/memory/batch-openai.ts` — OpenAI batch API
- `src/memory/batch-gemini.ts` — Gemini batch API
- `src/memory/batch-voyage.ts` — Voyage batch API
- `src/memory/batch-embedding-common.ts` — Re-export hub

### Search & Ranking
- `src/memory/hybrid.ts` — Hybrid merge (vector + keyword), `buildFtsQuery`, `bm25RankToScore`
- `src/memory/mmr.ts` — Maximal Marginal Relevance for diversity
- `src/memory/temporal-decay.ts` — Time-based relevance decay
- `src/memory/query-expansion.ts` — 7-language stop words, CJK tokenization

### Utilities
- `src/memory/internal.ts` — Chunking, file discovery, multimodal detection, hashing
- `src/memory/schema.ts` — SQLite schema (meta, files, chunks, embedding_cache, chunks_fts)
- `src/memory/types.ts` — `MemorySearchResult`, `MemorySearchManager`, `MemoryProviderStatus`
- `src/memory/multimodal.ts` — Image/audio file classification
- `src/memory/session-files.ts` — Session transcript indexing
- `src/memory/memory-flush.ts` — Pre-turn context preservation

## Architecture

### Two-Layer Design

```
Source of Truth: ~/.openclaude/memory/*.md (markdown files)
Search Index:    ~/.openclaude/memory/openclaude.sqlite (FTS5 + sqlite-vec)
```

### Search Pipeline

```
query → embedQuery() → searchVector() ──┐
query → extractKeywords() → searchKeyword() ──┤
                                              ├→ mergeHybridResults → temporalDecay → MMR → results
```

Falls back to FTS-only when no embedding provider is configured.

### Class Hierarchy

```
MemoryManagerSyncOps (base: DB, schema, file sync, watcher)
  └─ MemoryManagerEmbeddingOps (embedding batches, cache, retry)
       └─ MemoryIndexManager (search, readFile, status, probing)
```

### Config

Memory config lives in `~/.openclaude/config.json` under the `memory` key. All fields have defaults — a minimal `{ "memory": { "dbPath": "..." } }` works (FTS-only mode). To enable vector search, set `provider` to an embedding provider and configure the API key.

Key config fields: `provider`, `model`, `remote.apiKey`, `store.vector.enabled`, `query.hybrid`, `sync.watch`, `chunking`, `cache`.

## Key Patterns

- Markdown files chunked with configurable token size (default 400) and overlap (default 80)
- MMR ensures diverse results (lambda clamping, tiebreakers)
- Temporal decay: exponential with configurable half-life, evergreen files exempt
- 7-language stop words: EN, ES, PT, AR, KO, JA, ZH with CJK n-gram tokenization
- sqlite-vec for in-DB vector search with in-memory cosine fallback
- Embedding cache deduplicates by provider/model/hash
- File watcher (chokidar) for live re-indexing when `sync.watch` enabled

### Memory Flush (Pre-Turn Context Preservation)

`src/memory/memory-flush.ts` saves durable facts to dated markdown files before context compaction:

- `shouldFlushMemory(session)` — returns true when flush is needed
- `flushSessionToMemory()` — extracts facts and appends to `~/.openclaude/memory/YYYY-MM-DD.md`
- Token trigger: flushes when `totalInputTokens >= 65%` of effective context window
- Compaction trigger: flushes when auto-compaction has occurred since last flush
- Called by router pre-turn (before user message dispatch)
