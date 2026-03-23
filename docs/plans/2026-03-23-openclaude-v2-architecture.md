# OpenClaude v2 — Architecture & Implementation Plan

## Problem Statement

OpenClaude v1 rebuilds ~50% of what Claude Code now provides natively (skills,
sessions, subagents, routing, system prompts, MCP tools). The result is 35k lines
of code, 97 test files, and a maintenance burden that grows with every Claude Code
release.

## Native Feature Evaluation

| Feature | What it does | Sufficient? | Why / Why not |
|---|---|---|---|
| **Skills** (`.claude/skills/`) | Reusable workflows with YAML frontmatter, auto-invocation, args | **Yes** | Replaces `src/skills/` entirely |
| **Agents** (`.claude/agents/`) | Subagents with tool restrictions, model override, hooks | **Yes** | Replaces `src/engine/subagent-*` |
| **Hooks** (22 events) | Shell/HTTP/prompt automation at lifecycle points | **Yes** | Replaces `src/router/` dispatch |
| **Sessions** (`--session-id`/`--resume`) | Built-in persistence, transcripts, compaction | **Yes** | Replaces `src/engine/session-*` |
| **CLAUDE.md** + rules | Persistent instructions, path-scoped rules, imports | **Yes** | Replaces `src/engine/system-prompt.ts` |
| **`@import`** in CLAUDE.md | Pull external files into context at session start | **Yes** | Enables layered workspace files (tested, works) |
| **Auto-memory** (`MEMORY.md`) | 200 lines auto-loaded, topic files on demand, cross-session | **No** | 200-line limit, no semantic search, no entity resolution, no knowledge graph |
| **/loop** | Recurring prompts at intervals | **No** | Dies on terminal close. 3-day expiry. Session-scoped only |
| **Channels** (Telegram) | MCP-based message bridge | **No** | Research preview. Requires open terminal. No daemon mode. Bun-only |
| **Desktop scheduled tasks** | Recurring tasks in desktop app | **No** | Requires desktop app open. Not unattended |
| **Plugins** | Package skills/agents/hooks/MCP | **Yes** (for distribution) | Cannot run background daemons |

### What native features CANNOT do

1. **Always-on daemon** — Claude Code has no headless mode.
2. **Telegram without open terminal** — Channels require active session.
3. **Durable cron with delivery** — No unattended scheduling.
4. **Advanced memory** — No semantic search, knowledge graph, or entity resolution.

### The Project-Scoping Problem

Claude Code is built for **project-specific sessions**:
- `.claude/` config loads relative to the working directory
- Sessions live in `~/.claude/projects/<encoded-cwd>/`
- CLAUDE.md, skills, agents, rules are all tied to one CWD
- Auto-memory (MEMORY.md) is per-project

OpenClaude is a **general-purpose personal assistant**:
- Not tied to any one repo
- Should help with coding across ANY project
- Should handle non-coding tasks (research, reminders, general questions)
- Must support multiple independent agents on one machine

### Solution: Self-Contained Agent Directories

Claude Code loads `.claude/` config from the **current working directory**. By
giving each agent its own directory with its own `.claude/`, we turn Claude Code's
project-scoping into agent-scoping. ClaudeClaw sets CWD to the agent's directory
when spawning a session.

OpenClaw's workspace pattern (IDENTITY.md, SOUL.md, AGENTS.md, USER.md, TOOLS.md)
provides layered identity. Claude Code's `@import` in CLAUDE.md loads these files
natively — no custom system-prompt injection needed.

**Verified by experiment:**
- `@import` with relative paths from CLAUDE.md ✓
- User-level `~/.claude/` + project-level `.claude/` layer together ✓
- User-level skills available from any CWD ✓
- Works from any working directory ✓

## Memory System Evaluation

Memory is the core differentiator for a personal AI assistant. Native auto-memory
(200-line `MEMORY.md`) has no search, no entity resolution, no temporal awareness.
We evaluated every major AI memory system:

### Comparison Matrix

| System | LongMemEval | Self-hosted | MCP Native | License | Local LLMs | Deploy | Cost |
|---|---|---|---|---|---|---|---|
| [**Hindsight**](https://github.com/vectorize-io/hindsight) | **91.4%** (Virginia Tech verified) | **Yes** (embedded PG) | **MCP-first** | **MIT** | **Ollama** | **1 Docker cmd** | **Free** |
| [**Supermemory**](https://github.com/supermemoryai/supermemory) | ~99% (self-reported) | Partial (Cloudflare) | Plugin | Partial OSS | No | Cloud API | Free tier → paid |
| [**Mem0**](https://github.com/mem0ai/mem0) | ~67% | Yes (3 containers) | OpenMemory | Apache 2.0 | Ollama | Docker compose | Free → $249/mo (graph) |
| [**ClawMem**](https://github.com/yoloshii/ClawMem) | Not benchmarked | Yes | Yes (28 tools) | MIT (models: NC) | node-llama-cpp | Manual (Bun) | Free |
| [**Letta**](https://github.com/letta-ai/letta) | N/A | Yes | No MCP | Apache 2.0 | Yes | Docker | Free |
| [**mcp-memory-service**](https://github.com/doobidoo/mcp-memory-service) | Not benchmarked | Yes | MCP | MIT | Ollama | Docker | Free |

### Detailed Assessment

**[Supermemory](https://supermemory.ai/)** — Best claimed benchmarks (~99% LongMemEval)
- Custom vector graph engine with ontology-aware edges
- Knowledge updates, merges, contradictions — never just appends
- #1 on LongMemEval, LoCoMo, and ConvoMem
- **Disqualified:** Core engine is proprietary/cloud-dependent. Self-hosting
  requires enterprise agreement. No local LLM support. Every request goes through
  their servers (latency + token burn). Not suitable for local-first personal assistant.

**[Mem0](https://mem0.ai/)** — Largest ecosystem (41k stars, $24M YC-backed)
- Two-phase pipeline: extraction + update (ADD/UPDATE/DELETE/NOOP)
- Graph-enhanced variant (Mem0ᵍ) for multi-session relationships
- Self-hosted: Docker with FastAPI + PostgreSQL/pgvector + Neo4j (3 containers)
- SOC 2 & HIPAA compliant, 24+ vector DBs supported
- **Downsides:** Graph memory gated behind $249/mo in cloud. Self-hosted needs 3
  containers + Neo4j (heavy for personal use). Lower benchmark scores (67% vs 91%).
  Steep pricing jump ($19 → $249) for best features.

**[Hindsight](https://hindsight.vectorize.io/)** — Best independently verified performance
- Biomimetic memory model: World facts, Experiences, Mental models
- 4 parallel retrieval strategies: semantic + BM25 + graph + temporal
- Cross-encoder reranking for precision
- Entity resolution ("Alice" = "my coworker Alice")
- 91.4% LongMemEval (verified by Virginia Tech Sanghani Center)
- MIT license, no feature gating
- Single Docker command, embedded PostgreSQL (requires LLM API key or Ollama)
- Ollama support for fully local operation (Ollama must be installed and running)
- MCP-first design — native integration with Claude Code
- 3.8k stars, growing rapidly, Fortune 500 production deployments
- **Winner for OpenClaude.**

**[ClawMem](https://github.com/yoloshii/ClawMem)** — Claude Code native
- Designed specifically for Claude Code and OpenClaw
- Dual mode: hooks (~90% of retrieval) + MCP (~10%)
- 28 MCP tools, decision extraction, handoff generation
- Local embeddings via node-llama-cpp
- **Downsides:** Not benchmarked against standard tests. Bun-only.
  Smaller community. SOTA reranker models under non-commercial license.
  Less mature than Hindsight or Mem0.

**[Letta](https://www.letta.com/)** — Full agent runtime
- OS-inspired memory tiers (core → conversational → archival)
- Agents actively manage their own memory
- **Disqualified:** It's a complete agent runtime, not a memory layer.
  Would conflict with Claude Code as the agent. Overkill.

### Why Hindsight Wins

| Factor | Hindsight | Mem0 (self-hosted) | Supermemory | ClawMem |
|---|---|---|---|---|
| Benchmark (LongMemEval) | **91.4%** verified | 67% | ~99% claimed | Unknown |
| License | **MIT** | Apache 2.0 | Partial OSS | MIT (models: NC) |
| Self-hosted complexity | **1 Docker command** | 3 containers + Neo4j | Enterprise only | Manual Bun setup |
| Local LLMs | **Ollama** | Ollama | No | node-llama-cpp |
| MCP integration | **MCP-first** | OpenMemory MCP | Plugin | MCP + hooks |
| Knowledge graph | **Entity resolution + graph** | Neo4j (self-hosted) | Ontology-aware | Semantic edges |
| Temporal awareness | **Time-range filtering** | Mem0ᵍ temporal | Limited | Temporal decay |
| Memory model | **Biomimetic (3 types)** | Flat facts | User profiles | Flat + graph |
| External dependencies | **Embedded PG + LLM key or Ollama** | PG + Neo4j + API | Cloudflare | SQLite + Bun |
| Feature gating | **None** | Graph = $249/mo cloud | Enterprise | SOTA models = NC |

Hindsight provides the best independently verified retrieval accuracy, simplest
deployment, most permissive license, and richest memory model — with zero cost
and zero cloud dependency.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Claude Code + ClaudeClaw + Hindsight               │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────────┐  │
│  │  ClaudeClaw   │  │  Hindsight    │  │  Native Claude Code     │  │
│  │  (plugin)     │  │  (MCP server) │  │                         │  │
│  │              │  │               │  │  - Skills               │  │
│  │  - Daemon    │  │  - Semantic   │  │  - Agents               │  │
│  │  - Telegram  │  │  - BM25      │  │  - Hooks                │  │
│  │  - Cron      │  │  - Graph     │  │  - Rules                │  │
│  │  - Heartbeat │  │  - Temporal  │  │  - Sessions             │  │
│  │  - Dashboard │  │  - Reranking │  │  - CLAUDE.md @import    │  │
│  │              │  │  - Entities  │  │                         │  │
│  │              │  │  - Mental    │  │                         │  │
│  │              │  │    models    │  │                         │  │
│  └──────────────┘  └───────────────┘  └─────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ~/.openclaude/agents/<name>/  (one per agent, self-contained) │  │
│  │                                                               │   │
│  │    .claude/                                                   │   │
│  │      CLAUDE.md        — @imports workspace identity files     │   │
│  │      .mcp.json        — Hindsight MCP server entry            │   │
│  │      settings.json    — Permissions + hooks                   │   │
│  │      skills/          — Agent's skills                        │   │
│  │      agents/          — Agent's subagents                     │   │
│  │      rules/           — Agent's rules                         │   │
│  │                                                               │   │
│  │    workspace/         — OpenClaw-style layered identity       │   │
│  │      IDENTITY.md      — Name, creature, vibe, emoji           │   │
│  │      SOUL.md          — Persona, tone, values                 │   │
│  │      AGENTS.md        — Operating rules, memory policy        │   │
│  │      USER.md          — Human's preferences                   │   │
│  │      TOOLS.md         — Local environment                     │   │
│  │      HEARTBEAT.md     — Periodic checklist                    │   │
│  │      MEMORY.md        — Curated cheat sheet (always in ctx)   │   │
│  │      memory/          — Daily digests (nightly cron from      │   │
│  │                          Hindsight)                           │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ClaudeClaw spawns Claude Code with:                               │
│    CWD = ~/.openclaude/agents/<name>/                              │
│    → .claude/ loads identity, skills, memory, rules                │
│    → Agent works on any project via absolute paths or cd           │
│                                                                     │
│  Multiple agents = multiple directories:                           │
│    ~/.openclaude/agents/nova/     (personal assistant)             │
│    ~/.openclaude/agents/atlas/    (work assistant)                 │
│    ~/.openclaude/agents/sentinel/ (monitoring bot)                 │
└─────────────────────────────────────────────────────────────────────┘

                    ┌──────────────────┐
                    │  Hindsight       │
                    │  Docker          │
                    │  (background)    │
                    │                  │
                    │  - PostgreSQL    │
                    │  - API :8888     │
                    │  - UI :9999      │
                    │  - Ollama (opt)  │
                    └──────────────────┘
```

### Component Responsibilities

**ClaudeClaw** (plugin — daemon + channels + scheduling):
- Background Bun process (managed via PID file)
- Telegram + Discord adapters
- Cron scheduler with timezone support + exclude windows
- Heartbeat (periodic checklist review + proactive action)
- Web dashboard at configurable port
- Session management via JSON file (`session.json` at `.claude/claudeclaw/session.json` — single global session with turn counts, compact tracking)
- Model routing (agentic mode with task-type detection)

**How ClaudeClaw spawns Claude Code** (verified from source — `src/runner.ts`):
```
// First message (new session):
Bun.spawn(["claude", "-p",
  "--output-format", "json",
  "--dangerously-skip-permissions",
  "--append-system-prompt", "<identity + CLAUDE.md>",
], { stdin: prompt })

// Subsequent messages (resume):
Bun.spawn(["claude", "-p",
  "--output-format", "text",
  "--dangerously-skip-permissions",
  "--append-system-prompt", "<identity + CLAUDE.md>",
  "--resume", sessionId,
], { stdin: prompt })
```
- Uses raw `claude -p` CLI — NOT the Agent SDK
- Prompts sent via **stdin**, not CLI args
- `--append-system-prompt` injects identity on **every** call (new + resume)
  — this is critical because it re-injects workspace content that would
  otherwise be lost after compaction
- Reads IDENTITY.md, USER.md, SOUL.md from its `prompts/` directory
- Also reads project-level `CLAUDE.md` and appends it
- JSON output on first call to capture `session_id`, text on resume
- Serial queue prevents concurrent `--resume` on same session
- Auto-compact on timeout (exit 124), then retry
- Fallback model on rate limit
- `--dangerously-skip-permissions` works with Pro/Max subscription (verified)

**Multi-agent: concurrent operation confirmed:**
- Each agent = separate ClaudeClaw process started from different CWD
- Each needs its own Telegram bot token (one bot per agent)
- Sessions isolated by CWD (different `~/.claude/projects/<encoded-cwd>/`)
- Each agent gets its own Hindsight Docker container (hard isolation)

**Hindsight** (MCP server — one container per agent, **not yet deployed**):
- 29 MCP tools total. Core: `retain`, `recall`, `reflect`. Also: `list_memories`,
  `get_memory`, `delete_memory`, `create_mental_model`, `list_mental_models`,
  `get_mental_model`, `update_mental_model`, `delete_mental_model`,
  `refresh_mental_model`, `list_directives`, `create_directive`, `delete_directive`,
  `list_documents`, `get_document`, `delete_document`, `list_operations`,
  `get_operation`, `cancel_operation`, `list_tags`, `get_bank`, `update_bank`,
  `delete_bank`, `clear_memories`, `list_banks`, `create_bank`, `get_bank_stats`.
  Tool selection configurable via `HINDSIGHT_API_MCP_ENABLED_TOOLS`.
- **Recall**: 4 parallel strategies (semantic + BM25 + graph + temporal) + reranking
- **Reflect**: generate new insights from existing memories
- Entity resolution (deduplicate people, concepts, decisions)
- Knowledge graph with entity/temporal/causal links
- Biomimetic memory types: world facts, experiences, learned mental models
- MCP-first: native integration with Claude Code
- Runs as Docker container (5 GB image) with embedded PostgreSQL + local
  embedding model (`BAAI/bge-small-en-v1.5`) + local reranker
  (`cross-encoder/ms-marco-MiniLM-L-6-v2`). RAM undocumented but likely
  >200MB due to bundled ML models (embedding + reranker loaded at startup).
- **Requires an LLM API key** (`HINDSIGHT_API_LLM_API_KEY`). Ollama is an
  alternative (`HINDSIGHT_API_LLM_PROVIDER=ollama`) but Ollama must be running
  and accessible from within Docker (`host.docker.internal:11434`).
  Fully keyless local operation requires a working Ollama install.
- **No `/health` endpoint** — use `/metrics` (Prometheus) or `/docs` (OpenAPI)
  to verify the server is up. Health check cron should use:
  `curl -sf http://localhost:8888/docs`
- **MCP endpoint is bank-scoped:** single-bank = `http://localhost:8888/mcp/{bank_id}/`,
  multi-bank = `http://localhost:8888/mcp/` (with `X-Bank-Id` header).
  Auth via `HINDSIGHT_API_MCP_AUTH_TOKEN` (Bearer).
- **Per-agent deployment:** each agent gets its own container on a unique port:
  - `hindsight-nova` → `:8888` / `:9999`
  - `hindsight-atlas` → `:8890` / `:9990`
  - Each agent's `.mcp.json` points to its own port + bank
  - Data volumes: `~/.hindsight-<agent>/` per agent

**Native Claude Code** (zero dependencies):
- Skills — reusable workflows
- Agents — restricted subagents
- Hooks — lifecycle automation
- Sessions — persistence and compaction
- CLAUDE.md + `@import` — loads workspace identity files
- Rules — path-scoped instructions

**OpenClaude** (config + workspace + ~300 lines of operational scripts):
- Source repo provides default templates for workspace files + Claude Code config
- `scripts/setup.sh` creates agent directories under `~/.openclaude/agents/`
- Each agent is fully self-contained: `.claude/` + `workspace/`
- Agents are organizationally independent (separate folders, separate sessions)
- Operational scripts for: health checks, memory governance, export/import, auto-retention

### How Identity Gets Loaded (Two Paths)

**Path 1: Interactive session** (`cd ~/.openclaude/agents/nova && claude`)
- Claude Code reads `.claude/CLAUDE.md` from CWD
- `@import` pulls workspace files into context
- Native skills, agents, rules from `.claude/` load normally

**Path 2: ClaudeClaw daemon** (background process)
- ClaudeClaw starts with CWD = `~/.openclaude/agents/nova/`
- Reads its own `prompts/` files (IDENTITY.md, USER.md, SOUL.md)
- Reads project-level CLAUDE.md
- Injects all via `--append-system-prompt` on every `claude -p` call

**Both paths result in the same identity.** The CLAUDE.md bridge file
uses `@import` for interactive use:

```markdown
# ~/.openclaude/agents/nova/.claude/CLAUDE.md

# OpenClaude Agent

You are a general-purpose personal assistant. Your identity and operating
rules are defined in your workspace files.

@../workspace/IDENTITY.md
@../workspace/SOUL.md
@../workspace/AGENTS.md
@../workspace/USER.md
@../workspace/TOOLS.md
@../workspace/MEMORY.md
```

ClaudeClaw also injects workspace files via `--append-system-prompt`, ensuring
identity persists across `--resume` calls (since `@import` in CLAUDE.md doesn't
re-inject on resume, but `--append-system-prompt` does).

### Workspace Files (from OpenClaw)

| File | Purpose | Who edits | How often |
|---|---|---|---|
| **IDENTITY.md** | Agent name, creature type, vibe, emoji | User or agent (bootstrap) | Once, then rarely |
| **SOUL.md** | Persona, tone, values, boundaries | User | Rarely |
| **AGENTS.md** | Operating rules, memory policy, red lines, group chat etiquette | User | Occasionally |
| **USER.md** | Human's name, timezone, preferences, context | Agent | Gradually over time |
| **TOOLS.md** | Local environment: SSH hosts, devices, camera names, services | User | When environment changes |
| **HEARTBEAT.md** | Periodic checklist for proactive check-ins | User | Occasionally |
| **MEMORY.md** | Curated cheat sheet — always loaded into context via @import | Agent | Gradually |
| **memory/YYYY-MM-DD.md** | Daily log (auto-generated by nightly cron) | Cron job | Nightly |

### Memory System

**Hindsight is the primary memory store.** Every session connects to the same
Hindsight Docker instance via MCP. The agent calls `retain` during conversations
to store important facts, decisions, and context. Hindsight persists everything
in its embedded PostgreSQL — independent of Claude Code sessions.

**AGENTS.md enforces the discipline:**
```markdown
## Memory Policy
When you learn something worth remembering — decisions, preferences, facts,
outcomes — immediately use Hindsight `retain` to store it. Do not rely on
session memory. Sessions are ephemeral. Hindsight is permanent.
```

**Nightly cron generates daily logs.** A cron job runs at 11pm and spawns a
session that queries Hindsight for everything retained that day, then writes a
human-readable summary to `workspace/memory/YYYY-MM-DD.md`.

```
Throughout the day (multiple sessions):
  9am session:  "Sean wants to refactor auth" → Hindsight retain
  11am session: "Decided on JWT approach"     → Hindsight retain
  3pm session:  "Deployed auth v2"            → Hindsight retain
  (sessions end, context gone — Hindsight keeps everything)

11pm nightly cron:
  → Recall "everything that happened today, {date}"
  → Hindsight returns all retained memories (temporal retrieval)
  → Write structured summary to workspace/memory/2026-03-23.md
```

**MEMORY.md — always-in-context cheat sheet.** The agent's top ~20 most important
things, loaded into every session via `@import`. Things like "Sean's main project
is X," "never deploy on Fridays," "preferred tech stack." The agent maintains
this file over time — adding, updating, removing entries as it learns. Unlike
Hindsight, MEMORY.md doesn't require a recall query — it's just there, every
session, immediately.

**Three layers of memory:**
- MEMORY.md = always loaded, curated, concise (the cheat sheet)
- Hindsight = searchable, semantic, thousands of entries (the system of record)
- Daily logs = human-readable digest, git-trackable (the archive)

**Hindsight temporal note:** Hindsight timestamps every memory automatically and
has temporal retrieval as one of its 4 search strategies. Time filtering is
inferred from natural language queries ("everything from today") rather than
explicit date-range API parameters. This is sufficient for daily log generation —
it's a digest, not an audit trail.

## Known Issues & Mitigations

Identified by independent review from Gemini, Claude Opus, and Codex/GPT-5.4.

### 1. CWD Identity Loss (when working on projects)

**Problem:** When an agent `cd`s into a project repo, the project's `.claude/`
overrides the agent's. The agent loses its identity, skills, and workspace.

**Mitigation:** ClaudeClaw never `cd`s — it stays in the agent directory and
injects identity via `--append-system-prompt`. For interactive use, the agent
works on projects via absolute paths or spawns a `coder` subagent. The agent's
home directory remains its CWD.

**Tradeoff:** The agent doesn't pick up project-specific `.claude/` config
(rules, skills) from repos it works on. This is acceptable for a general-purpose
assistant. For deep coding work on a specific project, use Claude Code directly
from that project directory instead of through the assistant.

### 2. Hindsight Multi-Agent Isolation

**Problem:** Agents sharing one Hindsight instance risk memory cross-contamination.

**Fix:** Separate Docker container per agent. Hard isolation, no shared state:
```bash
# Nova's memory
docker run -d --name hindsight-nova -p 8888:8888 -p 9999:9999 \
  -v ~/.hindsight-nova:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest

# Atlas's memory
docker run -d --name hindsight-atlas -p 8890:8888 -p 9990:9999 \
  -v ~/.hindsight-atlas:/home/hindsight/.pg0 \
  ghcr.io/vectorize-io/hindsight:latest
```

Each agent's `.mcp.json` points to its own port:
```json
{ "mcpServers": { "hindsight": { "type": "http", "url": "http://localhost:8888/mcp/nova/" } } }
```

**Cost:** ~200MB RAM per container. Acceptable for 2-3 agents on a laptop.

### 3. Memory Retention Reliability

**Problem:** Relying on the agent to call `retain` is voluntary compliance.

**Fix: Hybrid approach** — voluntary + automatic safety net.

**During session:** AGENTS.md instructs the agent to `retain` important facts
as they come up. This captures context-rich memories with the agent's judgment.

**On session end:** Claude Code `Stop` hook triggers `scripts/auto-retain.sh`:
1. Reads session transcript from `~/.claude/projects/<encoded-cwd>/`
2. Spawns a lightweight `claude -p` call (Haiku/Sonnet) with prompt:
   "Extract key facts, decisions, preferences, and outcomes from this transcript.
   Exclude anything already retained to Hindsight during the session.
   Output as a JSON array of strings."
3. Calls Hindsight REST API to retain each extracted fact:
   `POST http://localhost:8888/v1/default/banks/{bank_id}/memories`
   with `{"items": [{"content": "..."}]}` per fact
4. Logs what was retained to `workspace/memory/retain.log`

**Dedupe:** The extraction prompt explicitly excludes facts already retained
during the session. Not perfect, but Hindsight's entity resolution handles
duplicate facts gracefully (merges rather than duplicates).

**Cost:** One Haiku call per session end (~5-10s, minimal tokens).

**Custom code:** ~50 lines of bash.

### 4. MEMORY.md Governance

**Problem:** Agent-edited file grows unbounded, bloats context window.

**Fix:**
- Hard cap: 50 lines maximum, enforced by `PreToolUse` hook on Write/Edit
- Immutable files: IDENTITY.md, SOUL.md, AGENTS.md, TOOLS.md — agent cannot edit
- Mutable files: USER.md, MEMORY.md — agent can edit within limits
- Hook script: `scripts/check-memory-size.sh` (~15 lines)

### 5. Nightly Log Determinism

**Problem:** NLP-based temporal recall is probabilistic, not exact.

**Mitigation:** Daily logs are explicitly framed as **digests for humans**, not
reliable archives. Hindsight is the system of record. The nightly cron prompt is
made explicit: "List every memory retained between {start} and {end} for bank
{agent_name}. Do not summarize. List each one."

### 6. cron-worker Permission Contradiction

**Problem:** cron-worker defined as read-only but needs to write daily logs.

**Fix:** Rename to `cron-worker.md` with Write access scoped to
`workspace/memory/` only. Document in the agent definition that it has narrow
write access, not full write.

### 7. ClaudeClaw Dependency Risk

**Mitigation:**
- ClaudeClaw's core is ~550 lines of TypeScript. If abandoned, it can be forked
  or replaced with a minimal daemon (~100 lines) using the same `claude -p` pattern
- System-level cron (`crontab`) as backup for scheduled tasks
- `scripts/fallback-daemon.sh` (~80 lines) as emergency Telegram bot

### 8. Error Handling

**Fix:** System-level health monitoring (not dependent on ClaudeClaw):
```crontab
*/5 * * * * curl -sf http://localhost:8888/docs || docker restart hindsight
```
- `@import` failure: rule in `safety.md` instructs agent to alert if workspace
  files are missing from context
- ClaudeClaw failure: system crontab checks PID file, restarts if dead

### 9. Portability

**Fix:** `scripts/export-agent.sh` bundles agent folder + Hindsight DB dump +
credentials checklist. `scripts/import-agent.sh` restores on new machine.
Portability = "restorable from manifest," not just "copy folder."

### 10. Identity Drift Between Interactive and Daemon Paths

**Problem:** Interactive mode loads 6 workspace files via `@import` in CLAUDE.md.
ClaudeClaw reads its own `prompts/` directory (IDENTITY.md, USER.md, SOUL.md)
and appends project CLAUDE.md. Different source files = eventual drift.

**Fix:** ClaudeClaw's `prompts/` directory must be **symlinked** to the agent's
workspace files. During `scripts/setup.sh`:
```bash
ln -sf "$AGENT_DIR/workspace/IDENTITY.md" "$AGENT_DIR/.claude/claudeclaw/prompts/IDENTITY.md"
ln -sf "$AGENT_DIR/workspace/USER.md"     "$AGENT_DIR/.claude/claudeclaw/prompts/USER.md"
ln -sf "$AGENT_DIR/workspace/SOUL.md"     "$AGENT_DIR/.claude/claudeclaw/prompts/SOUL.md"
```
Both paths now read the same files. Single source of truth.

**Note:** ClaudeClaw also appends CLAUDE.md content. Since CLAUDE.md `@import`s
the same workspace files, there may be duplication in the daemon path. This is
acceptable — redundant identity is better than missing identity. If it causes
token pressure, ClaudeClaw's `loadPrompts()` can be overridden via project-level
prompt files at `.claude/claudeclaw/prompts/`.

## Operational Scripts (~300 lines total)

| Script | Purpose | Lines (est.) |
|---|---|---|
| `setup.sh` | Create new agent from templates | 30 |
| `uninstall.sh` | Remove agent | 10 |
| `auto-retain.sh` | Stop hook: LLM extraction + Hindsight retain (hybrid) | 50 |
| `check-memory-size.sh` | PreToolUse hook: enforce MEMORY.md 50-line cap | 15 |
| `health-check.sh` | System cron: verify Hindsight + ClaudeClaw alive | 20 |
| `export-agent.sh` | Bundle agent + Hindsight data for migration | 40 |
| `import-agent.sh` | Restore agent on new machine | 30 |
| `fallback-daemon.sh` | Emergency Telegram bot if ClaudeClaw breaks | 80 |

**35,000 lines → ~300 lines of operational scripts. Not zero, but honest.**

## Project Structure

**Source repo** (what you clone/maintain):
```
openclaude/
  templates/
    workspace/
      IDENTITY.md            # Default agent identity template
      SOUL.md                # Default persona template
      AGENTS.md              # Default operating rules (incl. memory policy)
      USER.md                # Default user profile template
      TOOLS.md               # Default environment template
      HEARTBEAT.md           # Default heartbeat checklist
      MEMORY.md              # Empty cheat sheet (agent populates over time)

    claude/
      CLAUDE.md              # Bridge file with @imports
      .mcp.json              # Hindsight MCP server entry
      settings.json          # Default permissions + hooks

      skills/
        bootstrap/SKILL.md   # One-time onboarding conversation
        standup/SKILL.md      # Daily git summary
        research/SKILL.md     # Deep web + memory research
        remind/SKILL.md       # Set reminders / manage tasks

      agents/
        cron-worker.md        # Read-only for scheduled tasks
        researcher.md         # WebSearch + Read only
        coder.md              # Full tool access for project work

      rules/
        safety.md             # Hard boundaries
        messaging.md          # Telegram reply formatting

  scripts/
    setup.sh                  # Create agent from templates
    uninstall.sh              # Remove agent
    auto-retain.sh            # Stop hook: extract + retain memories
    check-memory-size.sh      # PreToolUse hook: enforce MEMORY.md cap
    health-check.sh           # System cron: verify services alive
    export-agent.sh           # Bundle agent for migration
    import-agent.sh           # Restore agent on new machine
    fallback-daemon.sh        # Emergency Telegram bot

  docs/
    setup.md                  # Manual setup guide
    plans/                    # Architecture docs
```

**Installed location** (per agent, fully self-contained):
```
~/.openclaude/
  agents/
    nova/                                   # One agent = one folder
    │
    ├── .claude/                            # Claude Code config (loaded via CWD)
    │   ├── CLAUDE.md                       # Bridge: @imports workspace files
    │   ├── .mcp.json                       # Hindsight MCP
    │   ├── settings.json                   # Permissions, hooks
    │   │
    │   ├── skills/
    │   │   ├── bootstrap/SKILL.md          # One-time onboarding
    │   │   ├── standup/SKILL.md            # Daily standup
    │   │   ├── research/SKILL.md           # Deep research
    │   │   └── remind/SKILL.md             # Reminders
    │   │
    │   ├── agents/
    │   │   ├── cron-worker.md              # Read + scoped Write (memory/ only)
    │   │   ├── researcher.md               # Research subagent
    │   │   └── coder.md                    # Coding subagent
    │   │
    │   └── rules/
    │       ├── safety.md                   # Boundaries
    │       └── messaging.md                # Telegram formatting
    │
    └── workspace/                          # Agent's "home" (living documents)
        ├── IDENTITY.md                     # "I am Nova ✦"
        ├── SOUL.md                         # Persona, tone, values
        ├── AGENTS.md                       # Operating rules, memory policy
        ├── USER.md                         # "Sean, PST, concise answers"
        ├── TOOLS.md                        # SSH hosts, devices, services
        ├── HEARTBEAT.md                    # Periodic checklist
        ├── MEMORY.md                       # Curated cheat sheet (always in context)
        └── memory/                         # Auto-generated by nightly cron
            ├── 2026-03-22.md               # Daily digest from Hindsight
            └── 2026-03-23.md

    atlas/                                  # Second agent (same structure)
    ├── .claude/
    │   ├── CLAUDE.md                       # @imports atlas's workspace
    │   └── ...
    └── workspace/
        ├── IDENTITY.md                     # "I am Atlas 🌍"
        └── ...
```

**One agent = one folder. Back it up with `scripts/export-agent.sh`, restore
with `scripts/import-agent.sh`. Agents are organizationally independent.**

**Custom runtime code: 0 lines. Operational scripts: ~300 lines of bash.**

## Implementation Plan

### Phase 1: Hindsight Memory System (Day 1, morning)

**Goal:** Advanced memory running and accessible via MCP.

1. Start Hindsight (one container per agent):
   ```bash
   AGENT_NAME="nova"
   API_PORT=8888
   UI_PORT=9999

   # With OpenAI embeddings (recommended for quality):
   export OPENAI_API_KEY=sk-xxx
   docker run --rm -d --name "hindsight-$AGENT_NAME" \
     -p $API_PORT:8888 -p $UI_PORT:9999 \
     -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
     -v "$HOME/.hindsight-$AGENT_NAME:/home/hindsight/.pg0" \
     ghcr.io/vectorize-io/hindsight:latest

   # Or fully local with Ollama (no API key):
   docker run --rm -d --name "hindsight-$AGENT_NAME" \
     -p $API_PORT:8888 -p $UI_PORT:9999 \
     -e HINDSIGHT_API_LLM_PROVIDER=ollama \
     -e HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:11434 \
     -v "$HOME/.hindsight-$AGENT_NAME:/home/hindsight/.pg0" \
     ghcr.io/vectorize-io/hindsight:latest
   ```

2. Verify API is running: `curl http://localhost:8888/docs` (no `/health` endpoint)

3. Test in Claude Code session:
   - Retain: "Remember that our deployment uses blue-green strategy on AWS ECS"
   - Recall: "What do you know about our deployment?"
   - Reflect: "What patterns do you see in recent decisions?"

4. Verify Hindsight UI at `http://localhost:9999` — browse stored memories

**Validation:** Retain → recall round-trip works; entity resolution links related facts.

### Phase 2: Agent Directory + Templates (Day 1, afternoon)

**Goal:** Create first agent with OpenClaw-style workspace + Claude Code config.

1. Write `scripts/setup.sh`:
   ```bash
   #!/bin/bash
   set -e
   AGENT_NAME="${1:-nova}"
   SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
   AGENT_DIR="$HOME/.openclaude/agents/$AGENT_NAME"

   if [ -d "$AGENT_DIR" ]; then
     echo "Agent '$AGENT_NAME' already exists at $AGENT_DIR"
     exit 1
   fi

   echo "Creating agent '$AGENT_NAME'..."
   mkdir -p "$AGENT_DIR"/{.claude/skills,.claude/agents,.claude/rules,workspace/memory}

   # Copy Claude Code config
   cp -r "$SCRIPT_DIR/templates/claude/"* "$AGENT_DIR/.claude/"
   cp "$SCRIPT_DIR/templates/claude/.mcp.json" "$AGENT_DIR/.claude/"

   # Copy workspace templates
   cp "$SCRIPT_DIR/templates/workspace/"* "$AGENT_DIR/workspace/"

   echo ""
   echo "Agent '$AGENT_NAME' created at: $AGENT_DIR"
   echo "Next steps:"
   echo "  1. cd $AGENT_DIR && claude"
   echo "  2. Run /bootstrap to onboard your agent"
   echo "  3. Configure ClaudeClaw to use CWD=$AGENT_DIR"
   ```

2. Write workspace template files:
   - `IDENTITY.md` — placeholder for name, creature, vibe, emoji
   - `SOUL.md` — adapted from OpenClaw (be helpful, have opinions, earn trust)
   - `AGENTS.md` — operating rules, memory policy, red lines
   - `USER.md` — placeholder for human's info
   - `TOOLS.md` — placeholder for local environment
   - `HEARTBEAT.md` — default periodic checklist
   - `BOOTSTRAP.md` — first-run onboarding conversation

3. Write `.claude/CLAUDE.md` bridge file with `@imports`

4. Write `.claude/.mcp.json` with Hindsight entry

5. Test: `cd ~/.openclaude/agents/nova && claude` → verify workspace loads

**Validation:** Agent directory created, CLAUDE.md imports workspace files, identity loads.

### Phase 3: Skills + Agents + Rules (Day 2, morning)

**Goal:** Native Claude Code capabilities configured per agent.

1. Create skills:
   - `bootstrap/SKILL.md` — one-time onboarding ("Who am I? Who are you?")
   - `standup/SKILL.md` — git log summary (works from any CWD via absolute paths)
   - `research/SKILL.md` — deep research on any topic (web + Hindsight memory)
   - `remind/SKILL.md` — set reminders, manage personal tasks

2. Create subagents:
   - `cron-worker.md` — Read, Glob, Grep, Bash, Write (scoped to workspace/memory/)
   - `researcher.md` — Read, WebSearch, WebFetch only
   - `coder.md` — Full tool access, for project-specific coding tasks

3. Create rules:
   - `safety.md` — hard boundaries (never exfiltrate, ask before destructive ops)
   - `messaging.md` — Telegram reply formatting

4. Create `settings.json` with permissions

5. Test: `/bootstrap` onboards the agent, `/standup` works, subagents have
   correct tool restrictions

**Validation:** Skills invoke correctly, agents are tool-restricted, rules apply.

### Phase 4: ClaudeClaw + Telegram (Day 2, afternoon)

**Goal:** Telegram bot running via daemon, routed to agent directory.

1. Install ClaudeClaw:
   ```bash
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw
   ```
2. Configure:
   - Telegram bot token (from @BotFather)
   - Heartbeat interval (30 min)
   - **CWD = `~/.openclaude/agents/nova/`** (agent's home directory)
3. Start: `/claudeclaw:start`
4. Test: Telegram message → response with correct identity and memory

**Validation:** Telegram conversation with memory-augmented responses, correct identity.

### Phase 5: Cron + Heartbeat + Nightly Log (Day 3, morning)

**Goal:** Scheduled tasks delivering to Telegram, plus automated daily memory logs.

1. Configure ClaudeClaw heartbeat:
   - Active hours: 8am–10pm
   - Reads `workspace/HEARTBEAT.md` for checklist
   - Target: Telegram chat

2. Add cron jobs:
   - Daily standup at 9am
   - **Nightly memory log at 11pm:**
     - Spawns a session with CWD = agent directory
     - Queries Hindsight: "Recall everything that happened today, {date}"
     - Writes structured summary to `workspace/memory/YYYY-MM-DD.md`
     - Uses the `cron-worker` subagent (read-only, no destructive ops)
   - Any other recurring tasks

3. Test:
   - Heartbeat tick → Telegram delivery
   - Retain some memories → wait for 11pm cron → verify daily log generated
   - Verify daily log accurately reflects the day's retained memories

**Validation:** Cron fires and delivers without intervention. Nightly log
captures the day's Hindsight memories as a human-readable markdown file.

### Phase 6: Multi-Agent + Docs (Day 3, afternoon)

**Goal:** Second agent + documentation.

1. Create second agent: `scripts/setup.sh atlas`
2. Customize atlas's workspace (different IDENTITY.md, SOUL.md)
3. Configure ClaudeClaw to route different Telegram bots → different agents
4. Write `docs/setup.md`: prerequisites, step-by-step, troubleshooting
5. Verify both agents work independently

**Validation:** Two agents with different identities, both accessible via Telegram.

## What Gets Deleted from v1

**All of `src/`** — 35k lines, 97 test files:

- `src/engine/` — spawn, pool, sessions, system-prompt, subagents
- `src/gateway/` — HTTP server, auth, rate limiting, launchd/systemd
- `src/router/` — dispatch logic
- `src/channels/` — Telegram + Slack adapters
- `src/cron/` — scheduler, heartbeat, store
- `src/memory/` — embeddings, hybrid search, SQLite, 6 providers
- `src/skills/` — loader, commands
- `src/mcp/` — gateway tools server
- `src/tools/` — MCP tool implementations
- `src/config/` — schema, loader, types
- `src/cli/` — command handlers
- `src/wizard/` — onboarding
- `src/logging/` — logger, diagnostics

## Upgrade Path

| Need | Solution | Effort |
|---|---|---|
| New agent | `scripts/setup.sh <name>` | 1 minute |
| Slack channel | Wait for ClaudeClaw support, or write ~300-line bridge | 0 or 1 day |
| Discord | Already in ClaudeClaw — just configure | 10 minutes |
| Proactive messaging | ClaudeClaw exposes `send_message` | Config only |
| Native Channels (when stable) | Replace ClaudeClaw Telegram with official plugin | Config only |
| Switch memory provider | Swap `.mcp.json` Hindsight entry for Mem0/Supermemory/ClawMem | Config only |
| Share skills between agents | Copy skill files (intentionally no shared config) | Copy files |
| Migrate agent to new machine | `scripts/export-agent.sh` + `scripts/import-agent.sh` | Run scripts |

## Summary

| | v1 | v2 |
|---|---|---|
| **Runtime code** | 35,000 lines | 0 |
| **Operational scripts** | (included in runtime) | ~300 lines bash |
| **Test files** | 97 | 0 |
| **Production deps** | 15 | 0 |
| **External tools** | 0 (all custom) | 2 (ClaudeClaw + Hindsight) |
| **Setup time** | 30+ min | < 15 min |
| **Maintenance** | High | Low (scripts + config only) |
| **Scope** | Project-tied | **General-purpose** (per-agent directories) |
| **Multi-agent** | No | **Yes** — concurrent, one folder + one Telegram bot per agent |
| **Agent portability** | No | **Yes** — export/import scripts |
| **Memory benchmark** | Not tested | 91.4% LongMemEval |
| **Memory system** | Vector + BM25 (custom) | MEMORY.md (cheat sheet) + Hindsight (search) + daily logs (digest) |
| **Memory capture** | Manual | **Hook-driven** — auto-retain on session end |
| **Identity model** | Monolithic system prompt | **Layered** — IDENTITY + SOUL + AGENTS + USER + TOOLS |
| **Identity injection** | Custom system-prompt.ts | ClaudeClaw `--append-system-prompt` + CLAUDE.md `@import` |
| **Telegram** | Custom grammY adapter | ClaudeClaw plugin (`claude -p` CLI) |
| **Cron** | Custom croner scheduler | ClaudeClaw cron + system crontab backup |
| **Skills** | Custom loader | Native `.claude/skills/` |
| **Sessions** | Custom session-map | ClaudeClaw `session.json` + Claude Code `--resume` |
| **Bootstrap** | Config wizard | **Conversational** — agent "comes alive" via /bootstrap |
| **Error handling** | Custom logging | System cron health checks + hook-based alerts |
