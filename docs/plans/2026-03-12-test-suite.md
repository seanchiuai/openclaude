# OpenClaude Complete Test Suite Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Write the complete test suite that defines behavioral contracts for every OpenClaude module — existing and planned. Tests are the spec.

**Architecture:** Tests co-located next to source files (`src/foo/bar.test.ts`). Mock external deps (better-sqlite3, sqlite-vec, grammy, @slack/bolt, Claude CLI subprocess). Tests must be runnable even if implementation doesn't exist yet — use type stubs/interfaces. Each test file starts with a contract comment block.

**Tech Stack:** vitest, vi.fn(), vi.useFakeTimers(), vi.mock(), node:sqlite (DatabaseSync for :memory: DBs)

---

## Phase 1 — Harden Existing Modules

### Task 1: Config Schema Tests

**Files:**
- Rewrite: `src/config/schema.test.ts`

**Step 1: Write the test file**

Replace existing `src/config/schema.test.ts` with comprehensive contract tests covering:
- Valid minimal config passes
- Valid full config passes
- Missing required fields (botToken) fails
- Invalid types fail (maxConcurrent: "four")
- Defaults applied (maxConcurrent=4, defaultTimeout=300000)
- Unknown fields stripped
- Env var substitution: $VAR, ${VAR}, ${VAR:-default}, nested

Note: Env var substitution tests already exist in `env-substitution.test.ts` but schema.test.ts should test the full pipeline (load → substitute → validate).

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/config/schema.test.ts`

**Step 3: Commit**

```bash
git add src/config/schema.test.ts
git commit -m "test: comprehensive config schema contract tests"
```

---

### Task 2: Engine Spawn Tests

**Files:**
- Create: `src/engine/spawn.test.ts`

**Step 1: Write the test file**

Mock `node:child_process` spawn and `node:fs` write operations. Contract tests:
- Writes prompt to file, never CLI args
- Passes --input-file, --output-format json, --dangerously-skip-permissions
- Unsets CLAUDECODE env var
- Spawns with detached:true for process group
- Parses JSON output → ClaudeResult
- Handles non-JSON stdout gracefully
- Non-zero exit code → result.exitCode reflects it
- Timeout triggers SIGKILL to pgid (negative pid)
- AbortController cancels on timeout
- Process error event → rejection with error message

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/engine/spawn.test.ts`

**Step 3: Commit**

```bash
git add src/engine/spawn.test.ts
git commit -m "test: engine spawn contract tests"
```

---

### Task 3: Engine Pool Tests (Harden)

**Files:**
- Rewrite: `src/engine/pool.test.ts`

**Step 1: Expand existing pool tests**

Add missing contract tests:
- FIFO ordering of queued tasks
- killSession stops running process and dequeues next
- drain() kills all running, rejects all queued
- drain() prevents new submissions (already exists)
- stats() reflects running/queued counts accurately
- Failed task frees slot for next queued task

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/engine/pool.test.ts`

**Step 3: Commit**

```bash
git add src/engine/pool.test.ts
git commit -m "test: harden engine pool contract tests"
```

---

### Task 4: Gateway Lifecycle Tests

**Files:**
- Create: `src/gateway/lifecycle.test.ts`

**Step 1: Write the test file**

Mock config loader, process pool, channel creation, HTTP server, fs operations.
- Boots with minimal config (no channels)
- Boots with telegram enabled → starts telegram
- Boots with slack enabled → starts slack
- Writes PID file on start
- Removes PID file on shutdown
- Shutdown stops channels → drains pool → closes HTTP
- SIGTERM triggers graceful shutdown
- SIGINT triggers graceful shutdown
- readPidFile returns null for dead process (stale PID)
- Health endpoint returns 200 with uptime

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/gateway/lifecycle.test.ts`

**Step 3: Commit**

```bash
git add src/gateway/lifecycle.test.ts
git commit -m "test: gateway lifecycle contract tests"
```

---

### Task 5: HTTP Endpoint Tests

**Files:**
- Create: `src/gateway/http.test.ts`

**Step 1: Write the test file**

Test the Hono app directly (no real HTTP server):
- GET /health → 200 with status, uptime, pool stats
- GET /health → includes channel list (via /ready)
- Unknown routes → 404

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/gateway/http.test.ts`

**Step 3: Commit**

```bash
git add src/gateway/http.test.ts
git commit -m "test: HTTP endpoint contract tests"
```

---

### Task 6: Telegram Bot Tests

**Files:**
- Create: `src/channels/telegram/bot.test.ts`

**Step 1: Write the test file**

Mock grammy Bot class and apiThrottler. Contract tests:
- Creates bot with provided token
- Applies API throttler
- Text message → normalized InboundMessage with correct fields
- Photo message → InboundMessage with media attachment (largest photo)
- Document message → InboundMessage with media attachment
- Allow-list blocks unauthorized user (silent drop)
- Allow-list allows authorized user
- No allow-list → all users allowed
- Auto-restart with exponential backoff on polling error
- Backoff caps at maxMs (30s)
- stop() stops polling and bot

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/channels/telegram/bot.test.ts`

**Step 3: Commit**

```bash
git add src/channels/telegram/bot.test.ts
git commit -m "test: telegram bot contract tests"
```

---

### Task 7: Telegram Send Tests (Harden)

**Files:**
- Rewrite: `src/channels/telegram/send.test.ts`

**Step 1: Expand existing send tests**

Add missing contract tests:
- Messages under 4096 chars sent as single message (already exists as 4000)
- Messages over 4096 chars split at paragraph boundaries (exists)
- Messages split at sentence boundaries when no paragraph break (exists)
- Each chunk ≤ 4096 chars
- sendMedia handles photo, document types
- Returns messageId and success status

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/channels/telegram/send.test.ts`

**Step 3: Commit**

```bash
git add src/channels/telegram/send.test.ts
git commit -m "test: harden telegram send contract tests"
```

---

### Task 8: Router Tests (Harden)

**Files:**
- Rewrite: `src/router/router.test.ts`

**Step 1: Expand existing router tests**

Add missing contract tests beyond parseCommand/deriveSessionKey:
- /command routes to command handler, not engine
- /command@botname strips bot mention
- Unknown /command falls through to engine
- User message routes to engine with session ID
- Same chat reuses session key
- Different chats get different session keys
- Cron source gets isolated session ID (cron- prefix)
- Engine error returns error message to channel
- Engine timeout returns timeout error to channel

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/router/router.test.ts`

**Step 3: Commit**

```bash
git add src/router/router.test.ts
git commit -m "test: harden router contract tests"
```

---

### Task 9: Commands Tests (Harden)

**Files:**
- Rewrite: `src/router/commands.test.ts`

**Step 1: Expand existing command tests**

Ensure all contracts covered:
- /help returns command list (exists)
- /list returns running sessions with IDs (exists)
- /list with no sessions returns "no active sessions" (exists)
- /stop <id> kills session, confirms (exists)
- /stop nonexistent returns not found
- /status returns pool stats (running, queued, max) (exists)

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/router/commands.test.ts`

**Step 3: Commit**

```bash
git add src/router/commands.test.ts
git commit -m "test: harden commands contract tests"
```

---

### Task 10: Run Phase 1 suite, commit

**Step 1: Run all Phase 1 tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run`

**Step 2: Fix any failures**

**Step 3: Commit if any fixes needed**

---

## Phase 2 — Memory System

### Task 11: Memory Schema Tests (Harden)

**Files:**
- Rewrite: `src/memory/schema.test.ts`

**Step 1: Expand existing schema tests**

Add missing contracts:
- Creates all tables: files, chunks, chunks_fts, embedding_cache, meta (exists partially)
- Idempotent — double init doesn't error (exists)
- FTS5 search returns matching chunks
- Foreign key: deleting file cascades to chunks (manual cascade via app logic)
- Vector table accepts and stores embeddings (if sqlite-vec available)

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/schema.test.ts`

**Step 3: Commit**

```bash
git add src/memory/schema.test.ts
git commit -m "test: harden memory schema contract tests"
```

---

### Task 12: Memory Sync Tests

**Files:**
- Create: `src/memory/sync.test.ts`

**Step 1: Write the test file**

Contract for the sync module (may not exist yet — define interface):
- New markdown file → file record + chunk records
- Modified file (different mtime) → chunks updated, not duplicated
- Deleted file → file and chunk records removed
- Chunks respect max token limit (split long files)
- YAML frontmatter parsed → stored as chunk metadata
- Non-markdown files ignored
- Empty file creates file record but no chunks
- Binary files ignored
- Concurrent sync of same file is idempotent

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/sync.test.ts`

**Step 3: Commit**

```bash
git add src/memory/sync.test.ts
git commit -m "test: memory sync contract tests"
```

---

### Task 13: Hybrid Search Tests

**Files:**
- Create: `src/memory/hybrid.test.ts`

**Step 1: Write the test file**

Test hybrid merge as pure function (extracted from OpenClaw):
- FTS5 keyword search returns BM25-ranked results
- Vector cosine search returns similarity-ranked results
- Hybrid merge applies 0.7 vector + 0.3 keyword weights
- Pure keyword fallback when no embeddings exist
- Empty query → empty results
- Results deduplicated across vector and keyword hits
- Score normalization: all scores in [0, 1]

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/hybrid.test.ts`

**Step 3: Commit**

```bash
git add src/memory/hybrid.test.ts
git commit -m "test: hybrid search contract tests"
```

---

### Task 14: Temporal Decay Tests

**Files:**
- Create: `src/memory/temporal-decay.test.ts`

**Step 1: Write the test file**

Pure function tests (no mocks needed):
- Age 0 days → score multiplier ~1.0
- Age 30 days → score multiplier ~0.5
- Age 60 days → score multiplier ~0.25
- Age 365 days → score multiplier near 0
- Evergreen flag → multiplier always 1.0
- Decay applied at query time (stored scores unchanged)
- Custom half-life parameter works

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/temporal-decay.test.ts`

**Step 3: Commit**

```bash
git add src/memory/temporal-decay.test.ts
git commit -m "test: temporal decay contract tests"
```

---

### Task 15: MMR Re-ranking Tests

**Files:**
- Create: `src/memory/mmr.test.ts`

**Step 1: Write the test file**

Pure function tests:
- lambda=1.0 → pure relevance order
- lambda=0.0 → maximum diversity
- Near-duplicate results pushed down in ranking
- Respects top_k limit
- Single result → returned as-is
- Empty input → empty output

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/mmr.test.ts`

**Step 3: Commit**

```bash
git add src/memory/mmr.test.ts
git commit -m "test: MMR re-ranking contract tests"
```

---

### Task 16: Embeddings Tests

**Files:**
- Create: `src/memory/embeddings.test.ts`

**Step 1: Write the test file**

Mock embedding providers:
- Local provider returns fixed-dimension vectors
- Cache hit → skips provider, returns cached
- Cache miss → calls provider, caches result
- Batch embedding splits at batch size limit
- Provider timeout → error propagated
- Multiple providers: auto-selection based on config
- Ollama provider handles connection refused gracefully

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/embeddings.test.ts`

**Step 3: Commit**

```bash
git add src/memory/embeddings.test.ts
git commit -m "test: embeddings contract tests"
```

---

### Task 17: Memory Flush Tests

**Files:**
- Create: `src/memory/memory-flush.test.ts`

**Step 1: Write the test file**

Mock fs and Claude subprocess:
- Extracts key facts from session transcript
- Writes to ~/.openclaude/memory/YYYY-MM-DD.md
- Triggers sync after write
- Empty/trivial session → no flush
- Appends to existing date file, doesn't overwrite

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/memory/memory-flush.test.ts`

**Step 3: Commit**

```bash
git add src/memory/memory-flush.test.ts
git commit -m "test: memory flush contract tests"
```

---

### Task 18: Memory Tools Tests

**Files:**
- Create: `src/tools/memory-tools.test.ts`

**Step 1: Write the test file**

Mock memory index:
- memory_search returns ranked results with scores
- memory_search respects top_k
- memory_search empty query → empty results
- memory_search with filters narrows results
- memory_get returns full content by path
- memory_get nonexistent path → error

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/tools/memory-tools.test.ts`

**Step 3: Commit**

```bash
git add src/tools/memory-tools.test.ts
git commit -m "test: memory tools contract tests"
```

---

### Task 19: Run Phase 2 suite, commit

**Step 1: Run all tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run`

**Step 2: Fix any conflicts**

**Step 3: Commit**

---

## Phase 3 — Cron, Heartbeat, Slack, Skills

### Task 20: Cron Service Tests

**Files:**
- Create: `src/cron/service.test.ts`

**Step 1: Write the test file**

Mock fs (jobs.json), fake timers, mock pool:
- Add job → persisted to jobs.json
- Remove job → removed from jobs.json
- List jobs → all jobs with next fire time
- Enable/disable toggle persists
- Cron expression validated (invalid → error)
- Duplicate job name → error
- Job fires at correct time (fake timers)
- Isolated mode → pool.submit with cron- session
- Main mode → injects into existing session
- Startup loads persisted jobs and schedules them
- Shutdown cancels all scheduled timers

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/cron/service.test.ts`

**Step 3: Commit**

```bash
git add src/cron/service.test.ts
git commit -m "test: cron service contract tests"
```

---

### Task 21: Heartbeat Tests

**Files:**
- Create: `src/cron/heartbeat.test.ts`

**Step 1: Write the test file**

Mock fs, fake timers, mock pool and channel:
- Reads HEARTBEAT.md content
- Fires at configured interval (fake timers)
- Passes checklist to isolated Claude session
- Non-trivial response → delivered to target channel
- Empty/trivial response ("nothing to do") → not sent
- Missing HEARTBEAT.md → skips silently
- Respects enabled/disabled config

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/cron/heartbeat.test.ts`

**Step 3: Commit**

```bash
git add src/cron/heartbeat.test.ts
git commit -m "test: heartbeat contract tests"
```

---

### Task 22: Slack Bot Tests

**Files:**
- Create: `src/channels/slack/bot.test.ts`

**Step 1: Write the test file**

Mock @slack/bolt App class:
- Creates Bolt app with bot + app tokens
- Socket mode connection
- Message event → normalized InboundMessage
- Thread message preserves threadId
- Allow-list blocks unauthorized
- App mention event → treated as message
- Auto-restart on disconnect
- stop() disconnects cleanly

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/channels/slack/bot.test.ts`

**Step 3: Commit**

```bash
git add src/channels/slack/bot.test.ts
git commit -m "test: slack bot contract tests"
```

---

### Task 23: Slack Send Tests

**Files:**
- Create: `src/channels/slack/send.test.ts`

**Step 1: Write the test file**

Mock Slack WebClient:
- Messages under 4000 chars sent as single message
- Long messages split into blocks
- Thread reply uses thread_ts
- sendMedia uploads file to channel
- Returns messageId and success

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/channels/slack/send.test.ts`

**Step 3: Commit**

```bash
git add src/channels/slack/send.test.ts
git commit -m "test: slack send contract tests"
```

---

### Task 24: Skills Loader Tests

**Files:**
- Create: `src/skills/loader.test.ts`

**Step 1: Write the test file**

Mock fs for skill discovery:
- Discovers SKILL.md files in ~/.openclaude/skills/
- Parses YAML frontmatter (name, description, triggers)
- Loads skill body as markdown
- Invalid frontmatter → skip with warning
- Nested directory discovery
- Hot-reload on file change

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/skills/loader.test.ts`

**Step 3: Commit**

```bash
git add src/skills/loader.test.ts
git commit -m "test: skills loader contract tests"
```

---

### Task 25: Skills Commands Tests

**Files:**
- Create: `src/skills/commands.test.ts`

**Step 1: Write the test file**

- Slash command matches skill trigger
- Skill content injected into Claude prompt
- Unknown skill command → "skill not found"
- /skills list → shows all loaded skills

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/skills/commands.test.ts`

**Step 3: Commit**

```bash
git add src/skills/commands.test.ts
git commit -m "test: skills commands contract tests"
```

---

### Task 26: Send Tool Tests

**Files:**
- Create: `src/tools/send-tool.test.ts`

**Step 1: Write the test file**

Mock channel adapters:
- Send to telegram channel → delivered
- Send to slack channel → delivered
- Send to unknown channel → error
- Send when channel not started → error

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/tools/send-tool.test.ts`

**Step 3: Commit**

```bash
git add src/tools/send-tool.test.ts
git commit -m "test: send tool contract tests"
```

---

### Task 27: File Tools Tests

**Files:**
- Create: `src/tools/file-tools.test.ts`

**Step 1: Write the test file**

Use real tmp directories:
- read_file returns file content
- write_file creates/overwrites file
- list_directory returns entries
- Path traversal outside workspace → blocked

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/tools/file-tools.test.ts`

**Step 3: Commit**

```bash
git add src/tools/file-tools.test.ts
git commit -m "test: file tools contract tests"
```

---

### Task 28: Run Phase 3 suite, commit

**Step 1: Run all tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run`

**Step 2: Fix any conflicts**

**Step 3: Commit**

---

## Phase 4 — Integration & CLI

### Task 29: CLI Commands Tests

**Files:**
- Create: `src/cli/commands.test.ts`

**Step 1: Write the test file**

Mock gateway lifecycle, process signals:
- `openclaude start` spawns gateway (daemonized)
- `openclaude stop` sends SIGTERM to PID
- `openclaude status` shows running/stopped + stats
- `openclaude setup` creates default config interactively
- `openclaude start` when already running → error

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/cli/commands.test.ts`

**Step 3: Commit**

```bash
git add src/cli/commands.test.ts
git commit -m "test: CLI commands contract tests"
```

---

### Task 30: Integration Boot Tests

**Files:**
- Create: `src/integration/boot.test.ts`

**Step 1: Write the test file**

Mock all subsystems, test orchestration order:
- Full boot → config → memory → cron → channels → ready
- Shutdown reverse order → channels → cron → memory → pool
- Missing config → helpful error message
- Invalid config → Zod error with path

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/integration/boot.test.ts`

**Step 3: Commit**

```bash
git add src/integration/boot.test.ts
git commit -m "test: integration boot contract tests"
```

---

### Task 31: Integration Message Flow Tests

**Files:**
- Create: `src/integration/message-flow.test.ts`

**Step 1: Write the test file**

Mock all subsystems, test end-to-end message flows:
- Telegram text → router → engine → response → telegram outbound
- Slack text → router → engine → response → slack outbound
- /command → router → direct response (no engine)
- Cron trigger → isolated session → proactive message to channel
- Heartbeat → reads checklist → engine → conditional delivery

**Step 2: Run tests**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run src/integration/message-flow.test.ts`

**Step 3: Commit**

```bash
git add src/integration/message-flow.test.ts
git commit -m "test: integration message flow contract tests"
```

---

### Task 32: Run full suite, final commit

**Step 1: Run complete test suite**

Run: `cd /Users/seanchiu/Desktop/openclaude && pnpm vitest run`

**Step 2: Fix any failures**

**Step 3: Final commit**

```bash
git commit -m "test: complete OpenClaude test suite — all phases"
```
