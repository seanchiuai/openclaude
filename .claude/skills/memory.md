---
name: memory
description: Hybrid vector + keyword search with SQLite FTS5, sqlite-vec, MMR diversity, temporal decay
---

# Memory - Hybrid Search System

Two-layer memory system extracted from OpenClaw: markdown files as source of truth, SQLite FTS5 + sqlite-vec as search index.

## When to Use This Skill

- Modifying search scoring or ranking
- Working with embedding providers
- Changing markdown chunking behavior
- Adding new memory operations
- Debugging search quality issues

## Key Files

- `src/memory/manager.ts` - Main MemoryManager interface
- `src/memory/hybrid.ts` - Hybrid search merging (vector 0.7 + keyword 0.3)
- `src/memory/internal.ts` - Markdown chunking, file discovery
- `src/memory/mmr.ts` - Maximal Marginal Relevance for diversity
- `src/memory/temporal-decay.ts` - Time-based relevance decay
- `src/memory/memory-flush.ts` - Pre-turn context preservation flush
- `src/memory/memory-flush.test.ts` - Flush trigger and behavior tests

## Architecture

### Two-Layer Design

```
Source of Truth: ~/.openclaude/memory/*.md (markdown files)
Search Index:    ~/.openclaude/memory/openclaude.sqlite (FTS5 + sqlite-vec)
```

### Search Pipeline

```
query → [vector search (0.7)] + [FTS5 keyword search (0.3)] → merge → MMR → temporal decay → results
```

### Key Interfaces

```typescript
interface MemoryManagerConfig {
  dbPath: string;
  workspaceDir: string;
  chunkTokens?: number;      // default 512
  chunkOverlap?: number;     // default 128
  vectorWeight?: number;     // default 0.7
  textWeight?: number;       // default 0.3
}

interface MemorySearchResult {
  id: string;
  path: string;
  citation?: string;
  snippet: string;
  score: number;
  startLine: number;
  endLine: number;
}
```

### Operations

- `search(query, opts?)` — Hybrid vector + keyword search
- `sync()` — Scan markdown files, update SQLite index
- `readFile(relPath, from?, lines?)` — Read full file content

## Key Patterns

- Markdown files are chunked with configurable token size and overlap
- MMR ensures diverse results (not just top-N most similar)
- Temporal decay reduces relevance of old memories
- Auto-sync on manager creation scans for new/changed files

### Memory Flush (Pre-Turn Context Preservation)

`src/memory/memory-flush.ts` saves durable facts to dated markdown files before context compaction:

- `shouldFlushMemory(session)` — returns true when flush is needed
- `flushSessionToMemory()` — extracts facts and appends to `~/.openclaude/memory/YYYY-MM-DD.md`
- **Token trigger**: flushes when `totalInputTokens >= 65%` of effective context window
- **Compaction trigger**: flushes when auto-compaction has occurred since last flush
- Constants: `DEFAULT_CONTEXT_WINDOW = 200_000`, `FLUSH_THRESHOLD_RATIO = 0.65`
- Called by router pre-turn (before user message dispatch)
- Test coverage in `src/memory/memory-flush.test.ts`

## OpenClaw Reference

**This module was extracted from OpenClaw.** When adding features or fixing bugs, check the upstream first.

**Source:** `openclaw-source/src/memory/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `manager.ts` | `src/memory/manager.ts` | Simplified — removed multi-agent, runtime deps |
| `hybrid.ts` | `src/memory/hybrid.ts` | Direct port |
| `internal.ts` | `src/memory/internal.ts` | Direct port |
| `mmr.ts` | `src/memory/mmr.ts` | Direct port |
| `temporal-decay.ts` | `src/memory/temporal-decay.ts` | Direct port |
| `embeddings*.ts` | — | 6 embedding providers, batch processing |
| `qmd-*.ts` | — | Query expansion, scope filtering |
| `search-manager.ts` | — | Advanced search manager |

**Copy-first workflow:**
1. Find the feature in `openclaw-source/src/memory/`
2. Copy the implementation
3. Strip OpenClaw-specific deps (Pi runtime, multi-agent, complex providers)
4. Adapt imports to OpenClaude's simpler structure
5. Rename any "openclaw" references to "openclaude"
