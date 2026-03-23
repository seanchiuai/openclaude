# OpenClaude — Design Document

**Date:** 2026-03-12
**Status:** Approved
**Goal:** Build an open-source autonomous AI assistant powered by Claude Code CLI, forked from OpenClaw's architecture.

---

## Overview

OpenClaude is a pure Claude Code replacement for OpenClaw. It uses the `claude` CLI as its sole agent engine (leveraging Pro/Max subscriptions — no API keys needed), connects to Telegram and Slack for two-way autonomous communication, and provides persistent memory, cron/heartbeat scheduling, subagent orchestration, and file management.

## Non-Goals (MVP)

- No web dashboard / UI
- No voice input/output
- No channels beyond Telegram + Slack
- No SDK/API key integration — CLI only
- No dynamic LLM-based orchestrator routing (v1 uses fixed routing table)
- No vector search (v1 uses FTS5 only)

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│                OpenClaude Gateway                 │
│           (Node.js background daemon)             │
├───────────┬───────────┬──────────────────────────┤
│ Telegram  │   Slack   │   Channel Abstraction    │
│ (grammY)  │  (Bolt)   │   (normalized messages)  │
├───────────┴───────────┴──────────────────────────┤
│                Fixed Router                       │
│    /command → handle directly                     │
│    user message → main session                    │
│    cron job → isolated session                    │
│    heavy task → subagent pool                     │
├──────────────────────────────────────────────────┤
│            Claude Code CLI Engine                 │
│   spawn('claude', [...]) per agent turn           │
│   --dangerously-skip-permissions (sandboxed)      │
│   --project <unique-path> (session isolation)     │
│   Process pool: max 4 concurrent, request queue   │
├──────────────────────────────────────────────────┤
│  Subagent    │  Memory     │  Cron/Heartbeat     │
│  Registry    │  (SQLite    │  (Croner +          │
│  /list       │   FTS5)     │   setTimeout)       │
│  /stop       │             │                     │
│  /status     │             │                     │
├──────────────┴─────────────┴─────────────────────┤
│  File Manager  │  Skills (.md)  │  MCP Bridge    │
│  (local fs)    │  auto-loaded   │  (GH, GCal...) │
└────────────────┴────────────────┴────────────────┘
```

---

## Modules (Cherry-Picked from OpenClaw)

### KEEP (extract from OpenClaw)

| Module | Source | Library | Purpose |
|--------|--------|---------|---------|
| Telegram channel | `extensions/telegram/` | grammY v1.41 | Message I/O, long-polling, media |
| Slack channel | `extensions/slack/` | Bolt v4.6 | Socket mode, threads, bot+app tokens |
| Channel abstraction | `src/channels/` | — | Unified ChannelPlugin interface |
| Message routing | `src/routing/` | — | Session key derivation, binding tiers |
| Cron service | `src/cron/` | Croner v10 | Job store, timer, execution |
| Config loader | `src/config/` | — | YAML/JSON config, hot reload |
| Daemon | `src/daemon/` | — | launchd (macOS) / systemd (Linux) |

### THROW AWAY

| Module | Reason |
|--------|--------|
| Pi agent runtime | Replaced by Claude Code CLI |
| 40+ channel extensions | Only need Telegram + Slack |
| WebChat UI (Lit) | No dashboard |
| Mobile apps (Swift/Kotlin) | Not needed |
| LanceDB / vector search | SQLite FTS5 is sufficient for v1 |
| Plugin SDK | Building simpler skill system |
| Provider abstraction layer | Claude Code CLI is the only provider |
| Voice/TTS | Not needed |

### KEEP (extract from OpenClaw — Memory System)

| Module | Source | Purpose |
|--------|--------|---------|
| SQLite schema | `src/memory/memory-schema.ts` | Tables, FTS5, sqlite-vec, indexes |
| Memory manager | `src/memory/manager.ts` | MemoryIndexManager orchestration (841 LOC) |
| Sync ops | `src/memory/manager-sync-ops.ts` | File watching (chokidar), chunking, sync (1,391 LOC) |
| Embedding ops | `src/memory/manager-embedding-ops.ts` | Batching, caching, retry logic |
| Hybrid search | `src/memory/hybrid.ts` | Vector + FTS5 score merging |
| Temporal decay | `src/memory/temporal-decay.ts` | Exponential decay with evergreen support |
| MMR re-ranking | `src/memory/mmr.ts` | Diversity re-ranking (opt-in) |
| Embeddings | `src/memory/embeddings.ts` | 6 providers: local, OpenAI, Gemini, Voyage, Mistral, Ollama |
| Query expansion | `src/memory/query-expansion.ts` | FTS-only fallback with keyword extraction |
| Memory flush | `src/auto-reply/reply/memory-flush.ts` | Auto-save to memory/YYYY-MM-DD.md before compaction |
| Session memory | `src/memory/session-files.ts` | Index past session transcripts (experimental) |
| Search manager | `src/memory/search-manager.ts` | Backend routing + fallback |
| Memory tools | `src/agents/tools/memory-tool.ts` | memory_search + memory_get agent tools |
| Memory CLI | `src/cli/memory-cli.ts` | status, sync, search commands |
| Markdown chunking | `src/memory/internal.ts` | Line-based chunker with overlap |

### KEEP (extract from OpenClaw — Skills System)

| Module | Source | Purpose |
|--------|--------|---------|
| Skill loader | `src/agents/skills.ts` | Load, resolve, filter workspace skills |
| Skill workspace | `src/agents/skills/workspace.ts` | Build skill snapshot, prompt injection, sync |
| Skill config | `src/agents/skills/config.ts` | Resolve skill config, binary checks |
| Skill types | `src/agents/skills/types.ts` | SkillEntry, SkillSnapshot, SkillCommandSpec |
| Skill installer | `src/agents/skills-install.ts` | Download and install skill dependencies |
| Skill status | `src/agents/skills-status.ts` | Build skill status for CLI/gateway |
| Skill commands | `src/auto-reply/skill-commands.ts` | Parse and route skill slash commands |
| Skills CLI | `src/cli/skills-cli.ts` | List and inspect skills |
| Skill security | `src/security/skill-scanner.ts` | Scan skills for security issues |
| Bundled skills | `skills/` directory | 50+ bundled skills (github, slack, etc.) |

### KEEP (extract from OpenClaw — Agent Tools)

| Tool | Source | Purpose |
|------|--------|---------|
| Web fetch | `src/agents/tools/web-fetch.ts` | Fetch and parse web content |
| Web search | `src/agents/tools/web-search.ts` | Internet search with citations |
| Image tool | `src/agents/tools/image-tool.ts` | Process and analyze images |
| PDF tool | `src/agents/tools/pdf-tool.ts` | Extract and analyze PDFs |
| Message send | `src/agents/tools/sessions-send-tool.ts` | Send to any channel/session |
| Sessions list | `src/agents/tools/sessions-list-tool.ts` | List conversation sessions |
| Sessions spawn | `src/agents/tools/sessions-spawn-tool.ts` | Spawn new sessions |
| Subagents tool | `src/agents/tools/subagents-tool.ts` | Manage subagents |
| Cron tool | `src/agents/tools/cron-tool.ts` | Schedule jobs |
| Gateway tool | `src/agents/tools/gateway-tool.ts` | Gateway queries |

### BUILD NEW

| Module | Purpose |
|--------|---------|
| Claude Code engine | Spawn/manage `claude` CLI subprocesses |
| Subagent manager | Process pool, registry, /list /stop /status |
| Proactive messaging | Agent-initiated messages to channels |

---

## Component Details

### 1. Gateway (Daemon)

**Extracted from:** `src/gateway/`, `src/daemon/`

- Single Node.js process running as a background service
- launchd plist on macOS (`~/Library/LaunchAgents/ai.openclaude.gateway.plist`)
- systemd user unit on Linux (`~/.config/systemd/user/openclaude.service`)
- HTTP server (Hono) for health checks and future API
- In-process management of all channels, cron, memory, sessions
- Config stored at `~/.openclaude/config.json`
- Logs at `~/.openclaude/logs/`

### 2. Channel System

**Extracted from:** `extensions/telegram/`, `extensions/slack/`, `src/channels/`

Both channels implement the `ChannelPlugin` interface:

```typescript
interface ChannelPlugin {
  id: string;
  config: ChannelConfig;
  gateway: {
    startAccount(ctx: AccountContext): Promise<void>;
    stopAccount?(ctx: AccountContext): Promise<void>;
  };
  outbound: {
    sendText(params: SendTextParams): Promise<SendResult>;
    sendMedia?(params: SendMediaParams): Promise<SendResult>;
  };
}
```

**Telegram specifics:**
- grammY with long-polling (webhook mode optional)
- 4096 char chunk limit
- Image/file/document handling
- Rate limiting via `@grammyjs/transformer-throttler`

**Slack specifics:**
- Bolt with socket mode (default) or HTTP
- Bot token + app token
- Thread support, channel/DM handling

**Both:**
- Auto-restart with exponential backoff (5s initial, 5min max)
- Allow-list based security (configurable per channel)

### 3. Fixed Router

**Simplified from:** `src/routing/`

No LLM-based routing for v1. Fixed dispatch table:

```typescript
function route(message: InboundMessage): RouteAction {
  // 1. Static commands — handle directly in gateway
  if (message.text.startsWith('/')) {
    const cmd = parseCommand(message.text);
    if (GATEWAY_COMMANDS.has(cmd.name)) {
      return { type: 'gateway_command', command: cmd };
    }
  }

  // 2. Cron-triggered — isolated session
  if (message.source === 'cron') {
    return { type: 'isolated_session', task: message.payload };
  }

  // 3. User message — main session
  return { type: 'main_session', sessionKey: deriveSessionKey(message) };
}
```

**Gateway commands (handled without spawning Claude):**
- `/list` — show active subagents
- `/stop <id>` — kill a subagent
- `/status` — health, memory stats, cron summary
- `/cron list|add|remove` — manage scheduled tasks
- `/memory` — show memory stats

### 4. Claude Code CLI Engine

**New module.** The core replacement for Pi agent.

```typescript
interface ClaudeSession {
  id: string;
  projectPath: string;      // unique per session, prevents collision
  process: ChildProcess;
  status: 'running' | 'completed' | 'failed' | 'killed';
  startedAt: number;
  timeout: number;           // wall-clock timeout in ms
}
```

**Subprocess spawning:**

```typescript
function spawnClaude(task: AgentTask): ClaudeSession {
  const projectPath = path.join(SESSIONS_DIR, task.sessionId);
  mkdirSync(projectPath, { recursive: true });

  // Write task prompt to file (never pass user content as CLI args)
  const promptFile = path.join(projectPath, 'prompt.md');
  writeFileSync(promptFile, task.prompt);

  const proc = spawn('claude', [
    '-p',                                    // print mode (non-interactive)
    '--project', projectPath,                // isolated session directory
    '--dangerously-skip-permissions',        // sandboxed environment
    '--output-format', 'json',               // structured output
    '--input-file', promptFile,              // prompt via file, not args
  ], {
    cwd: task.workingDirectory,
    env: { ...process.env, CLAUDECODE: undefined },
    timeout: task.timeout || 300_000,        // 5 min default
  });

  return { id: task.sessionId, projectPath, process: proc, ... };
}
```

**Process pool:**
- Max 4 concurrent Claude Code processes (configurable)
- Request queue (FIFO) for excess requests
- Wall-clock timeout per process (default 5 min, configurable per task type)
- Process group kill on timeout (pgid, not just pid)
- Zombie process reaping

**Session isolation:**
- Each subagent gets a unique `--project` path under `~/.openclaude/sessions/<id>/`
- No use of `--continue` (global state collision risk)
- Session transcripts stored as JSONL for debugging

### 5. Subagent Manager

**New module.**

```typescript
interface Subagent {
  id: string;
  name: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'killed';
  task: string;              // description of what it's doing
  sessionId: string;
  channel: string;           // which channel requested it
  startedAt: number;
  result?: string;           // output when completed
}
```

**Registry:**
- In-memory Map<string, Subagent> with periodic persistence to disk
- Commands accessible from any channel:
  - `/list` → table of active subagents with status
  - `/stop <id>` → SIGKILL to process group, mark as killed
  - `/status` → system overview (active agents, memory usage, cron jobs)

**Lifecycle:**
1. User/cron sends task
2. Router dispatches to subagent manager
3. Manager queues task (or runs immediately if pool has capacity)
4. Claude Code subprocess spawned with isolated project path
5. Output captured from stdout (JSON format)
6. Result delivered back to originating channel
7. Subagent marked as completed, session cleaned up after retention period

### 6. Memory System

**Preserved from OpenClaw's memory system — the full two-layer architecture.**

**Architecture:**
```
Agent Query → memory_search tool
    ↓
SearchManager (backend routing + fallback)
    ↓
MemoryIndexManager (SQLite + embeddings)
    ├── Vector search (sqlite-vec, cosine distance)
    └── Keyword search (FTS5, BM25)
         ↓
    Merge & Re-rank (hybrid weights, MMR, temporal decay)
         ↓
    Return sorted results

File Watch / Session Events / Interval Timer
    ↓
Sync trigger → runSync()
    ├── List files (MEMORY.md, memory/*.md, sessions/*.jsonl)
    ├── Hash comparison (SHA-256, skip unchanged)
    ├── Chunk markdown (400 tokens/chunk, 80 token overlap)
    ├── Embed chunks (with caching & batching)
    ├── Upsert chunks + FTS index
    └── Update meta
```

**SQLite Schema (extracted from OpenClaw):**

```sql
-- File tracking
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  source TEXT,          -- 'memory' or 'sessions'
  hash TEXT,            -- SHA-256
  mtime INTEGER,
  size INTEGER
);

-- Indexed content chunks
CREATE TABLE chunks (
  id TEXT PRIMARY KEY,
  path TEXT, source TEXT,
  start_line INTEGER, end_line INTEGER,
  hash TEXT, model TEXT,
  text TEXT,
  embedding TEXT,       -- JSON-serialized float vector
  updated_at INTEGER
);

-- Vector search (sqlite-vec)
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  id TEXT PRIMARY KEY,
  embedding FLOAT[dims]
);

-- Full-text search
CREATE VIRTUAL TABLE chunks_fts USING fts5(
  text, id, path, source, model, start_line, end_line
);

-- Embedding cache
CREATE TABLE embedding_cache (
  provider TEXT, model TEXT, provider_key TEXT, hash TEXT,
  dims INTEGER, embedding TEXT, updated_at INTEGER,
  PRIMARY KEY (provider, model, provider_key, hash)
);

-- Index metadata
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
```

**Two-Layer Storage:**
- **Source of truth:** Markdown files on disk (`MEMORY.md`, `memory/YYYY-MM-DD.md`)
- **Index:** SQLite with FTS5 + sqlite-vec for fast retrieval
- Sync keeps index in sync with files via hash comparison

**Hybrid Search:**
```
final_score = vectorWeight * vectorScore + textWeight * textScore
```
- Default: vectorWeight=0.7, textWeight=0.3
- BM25 rank-to-score: `score = -rank / (1 + -rank)`
- Configurable candidate pool multiplier (4x)

**6 Embedding Providers (auto-selection chain):**
1. Local (node-llama-cpp) — zero cost, offline
2. OpenAI (text-embedding-3-small)
3. Gemini (gemini-embedding-001)
4. Voyage (voyage-4-large)
5. Mistral (mistral-embed)
6. Ollama (nomic-embed-text, local)
7. FTS-only fallback — works with zero API keys

**Embedding Batching & Caching:**
- Max 8,000 tokens per batch
- Provider-specific batch APIs (OpenAI, Gemini, Voyage)
- Retry: 3 attempts, exponential backoff (500ms → 8s)
- Cache in `embedding_cache` table, keyed by (provider, model, hash)

**Temporal Decay (opt-in):**
```
decay_multiplier = exp(-lambda * age_in_days)
lambda = ln(2) / halfLifeDays    // default 30 days
```
- `memory/YYYY-MM-DD.md` → age from filename
- Evergreen files (`MEMORY.md`, non-dated) → never decay
- Fallback: file mtime

**MMR Re-ranking (opt-in):**
```
mmr_score = lambda * relevance - (1 - lambda) * max_similarity_to_selected
```
- Lambda: 0.7 default (higher = more relevant, lower = more diverse)
- Similarity: Jaccard coefficient on lowercased tokens

**Memory Flush (auto-save before compaction):**
- Triggers when: `totalTokens >= contextWindow - reserveTokens - softThreshold`
- Writes to: `memory/YYYY-MM-DD.md` (append-only)
- Read-only files: MEMORY.md, SOUL.md never edited by flush
- Once per compaction cycle

**File Watching & Sync:**
- Chokidar watches MEMORY.md, memory/*, extraPaths
- Debounce: 1,500ms
- Sync on: session start, search (if dirty), file change, interval

**Session Memory (experimental):**
- Indexes past session transcripts (JSONL)
- Delta-based re-indexing (100KB or 50 messages threshold)
- Sensitive text redacted before indexing

**Agent Tools:**
- `memory_search(query, maxResults?, minScore?)` — semantic search with citations
- `memory_get(path, from?, lines?)` — read specific memory file snippet

**CLI Commands:**
- `openclaude memory status` — index stats, provider info
- `openclaude memory sync` — force re-index
- `openclaude memory search <query>` — CLI search

**Config Defaults:**

| Setting | Default |
|---------|---------|
| Chunk tokens | 400 |
| Chunk overlap | 80 |
| Provider | auto |
| Max results | 6 |
| Min score | 0.35 |
| Vector weight | 0.7 |
| Text weight | 0.3 |
| MMR enabled | false |
| Temporal decay | false |
| Half-life days | 30 |
| Watch debounce | 1,500ms |
| Sync on search | true |
| Sync on start | true |

### 7. Cron / Heartbeat

**Extracted from:** `src/cron/`

**Cron jobs:**
- Stored in `~/.openclaude/cron/jobs.json`
- Croner computes next fire time
- setTimeout (max 60s interval) arms the timer
- Two execution modes:
  - **Main session:** injects text as system event into existing conversation
  - **Isolated:** spawns fresh Claude Code session, delivers result to channel

```typescript
interface CronJob {
  id: string;
  name: string;
  schedule: string;           // cron expression
  prompt: string;             // what to tell Claude
  target: {                   // where to deliver results
    channel: 'telegram' | 'slack';
    chatId: string;
  };
  sessionMode: 'main' | 'isolated';
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt?: number;
}
```

**Heartbeat:**
- Reads `~/.openclaude/HEARTBEAT.md` checklist every N minutes (default 30)
- Runs an isolated Claude Code session with the checklist as prompt
- If response is non-trivial (not just "all good"), delivers to configured channel
- Mutex to prevent overlapping heartbeat runs

**Management via commands:**
- `/cron list` — show all jobs
- `/cron add "0 9 * * *" "Check my GitHub PRs"` — create job
- `/cron remove <id>` — delete job
- `/cron run <id>` — trigger immediately

### 8. File Manager

**New module.**

Exposes file operations through Claude Code's native tools. The gateway's system prompt injection tells Claude about the workspace:

```markdown
## File System
Your workspace is at: ~/.openclaude/workspace/
You can read, write, and manage files there using your built-in tools.
When a user asks you to create or send a file, save it to the workspace
and I will deliver it to them via their messaging channel.
```

The gateway monitors the workspace for new files and can send them as Telegram/Slack attachments.

### 9. Skills System

**Extracted from:** `src/agents/skills/`, `src/auto-reply/skill-commands.ts`, `src/cli/skills-cli.ts`, `skills/`

**Full OpenClaw skills architecture preserved:**

**Skill Format (SKILL.md with YAML frontmatter):**
```yaml
---
name: github
description: "GitHub operations via gh CLI"
metadata:
  openclaw:
    emoji: "🐙"
    requires: { bins: ["gh"] }
    install:
      - id: brew
        kind: brew
        formula: gh
---

## Instructions
(markdown playbook for the agent)
```

**Skill Discovery & Loading:**
- Scans `~/.openclaude/skills/` and project-local `.claude/skills/`
- Each skill: directory with `SKILL.md` + optional supporting files
- `loadWorkspaceSkillEntries()` — discovers all skills
- `buildWorkspaceSkillSnapshot()` — snapshot for a session
- `buildWorkspaceSkillsPrompt()` — injects skill descriptions into agent prompt
- `syncSkillsToWorkspace()` — syncs skills to session workspace

**Skill Commands:**
- Skills register slash commands (e.g., `/github`, `/summarize`)
- `skill-commands.ts` parses incoming messages for `/skill-name` patterns
- Routes to the matching skill's prompt injection

**Skill Installation:**
- Auto-install binary dependencies (brew, apt, npm)
- `skills-install.ts` handles download, extraction, fallback
- Configurable: `preferBrew`, `nodeManager` (npm/pnpm/yarn/bun)

**Skill Security:**
- `skill-scanner.ts` scans skills for security issues before loading
- Bundled allowlist for trusted built-in skills

**Bundled Skills (50+ from OpenClaw):**
- github, slack, obsidian, notion, trello, weather, summarize, etc.
- Cherry-pick relevant ones for OpenClaude (drop channel-specific ones like discord, whatsapp)

**Skills CLI:**
- `openclaude skills list` — show installed skills
- `openclaude skills inspect <name>` — show skill details

**Skills synced to each Claude Code session:**
- Gateway copies/symlinks skills to each session's project path
- Claude Code auto-discovers them via `~/.claude/skills/` or project `.claude/skills/`

### 10. Integrations (MCP)

Configured in `~/.openclaude/config.json`:

```json
{
  "mcp": {
    "github": {
      "command": "npx",
      "args": ["@anthropic/github-mcp"]
    },
    "google": {
      "command": "npx",
      "args": ["@anthropic/google-workspace-mcp"]
    },
    "supabase": {
      "command": "npx",
      "args": ["supabase-mcp"]
    }
  }
}
```

MCP server configs are passed to each Claude Code subprocess via `--mcp-config`.

---

## Directory Structure

```
~/.openclaude/
├── config.json              # main config (channels, MCP, settings)
├── HEARTBEAT.md             # heartbeat checklist
├── logs/
│   ├── gateway.log
│   └── gateway.err.log
├── cron/
│   └── jobs.json            # persistent cron job store
├── memory/
│   └── openclaude.sqlite    # FTS5 memory database
├── sessions/
│   └── <session-id>/        # isolated session directories
│       ├── prompt.md
│       ├── CLAUDE.md         # injected per-session
│       └── .claude/
│           └── settings.json
├── skills/                  # markdown skill playbooks
│   └── <skill-name>/
│       └── SKILL.md
└── workspace/               # file manager workspace
```

---

## Config File

```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_BOT_TOKEN",
      "allowFrom": ["123456789"]
    },
    "slack": {
      "enabled": true,
      "botToken": "$SLACK_BOT_TOKEN",
      "appToken": "$SLACK_APP_TOKEN",
      "mode": "socket"
    }
  },
  "agent": {
    "maxConcurrent": 4,
    "defaultTimeout": 300000,
    "model": "opus"
  },
  "heartbeat": {
    "enabled": true,
    "every": 1800000,
    "target": { "channel": "telegram", "chatId": "123456789" }
  },
  "mcp": {},
  "memory": {
    "dbPath": "~/.openclaude/memory/openclaude.sqlite"
  }
}
```

---

## Tech Stack

| Component | Choice | Version |
|-----------|--------|---------|
| Runtime | Node.js | >= 22 |
| Package manager | pnpm | 10.x |
| Language | TypeScript (ESM) | 5.x |
| HTTP server | Hono | 4.x |
| Telegram | grammY | 1.41 |
| Slack | @slack/bolt | 4.6 |
| Cron | Croner | 10.x |
| Database | better-sqlite3 | latest |
| Build | tsdown | latest |
| Lint | oxlint + oxfmt | latest |
| Test | vitest | latest |
| Validation | Zod v4 | latest |

---

## MVP Scope

### Phase 1: Core (Week 1-2)
- [ ] Project scaffolding (pnpm, TypeScript, ESM)
- [ ] Config loader
- [ ] Claude Code CLI engine (spawn, pool, timeout, output parsing)
- [ ] Gateway daemon (launchd/systemd)
- [ ] Telegram channel (extract from OpenClaw)
- [ ] Fixed router
- [ ] Basic /list, /stop, /status commands

### Phase 2: Memory + Cron (Week 3)
- [ ] SQLite memory system (FTS5)
- [ ] Memory search/save tool injection
- [ ] Cron service (extract from OpenClaw)
- [ ] Heartbeat runner
- [ ] Proactive messaging (agent → channel)

### Phase 3: Slack + Polish (Week 4)
- [ ] Slack channel (extract from OpenClaw)
- [ ] Skill auto-loading
- [ ] File manager
- [ ] MCP config passthrough
- [ ] CLI tool (`openclaude setup`, `openclaude start`, `openclaude status`)

### Phase 4: Open Source Launch
- [ ] README, contributing guide
- [ ] Docker/container sandbox setup
- [ ] GitHub Actions CI
- [ ] npm package publish

---

## Reviewer Feedback Incorporated

| Feedback Source | Key Point | How We Addressed It |
|----------------|-----------|---------------------|
| Gemini 2.5 Pro | Single point of failure | Accepted for v1; daemon auto-restart mitigates |
| Gemini 2.5 Pro | Replace setTimeout with BullMQ | Deferred to v2; Croner+setTimeout matches OpenClaw |
| Gemini 2.5 Pro | Containerize | Phase 4 Docker setup |
| Claude Sonnet 4.6 | Drop CLI for SDK | Rejected — CLI uses subscription, SDK needs API keys |
| Claude Sonnet 4.6 | SQLite only, no markdown source of truth | Adopted — single SQLite source of truth |
| Claude Sonnet 4.6 | Fixed routing, not dynamic LLM dispatch | Adopted — fixed routing table for v1 |
| Claude Sonnet 4.6 | Process pool with concurrency limit | Adopted — max 4 concurrent, request queue |
| Claude Sonnet 4.6 | Never pass message content as CLI args | Adopted — write to prompt file, pass --input-file |
| Claude Sonnet 4.6 | Unique --project path per subagent | Adopted — sessions/<id>/ isolation |
| Both | Context window management | Gateway tracks turn count, triggers flush before compaction |
| Both | Security sandboxing | --dangerously-skip-permissions in sandboxed container |
