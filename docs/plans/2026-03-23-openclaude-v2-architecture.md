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
| **Hooks** (25+ events) | Shell/HTTP/prompt automation at lifecycle points | **Yes** | Replaces `src/router/` dispatch |
| **Sessions** (`--session-id`/`--resume`) | Built-in persistence, transcripts, compaction | **Yes** | Replaces `src/engine/session-*` |
| **CLAUDE.md** + rules | Persistent instructions, path-scoped rules, imports | **Yes** | Replaces `src/engine/system-prompt.ts` |
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
5. **General-purpose assistant** — Claude Code is project-scoped by design.

### The Project-Scoping Problem

Claude Code is built for **project-specific sessions**:
- `.claude/` config loads relative to the working directory
- Sessions live in `~/.claude/projects/<encoded-cwd>/`
- CLAUDE.md, skills, agents, rules are all tied to one repo
- Auto-memory (MEMORY.md) is per-project

OpenClaude is a **general-purpose personal assistant**:
- Not tied to any one repo
- Should help with coding across ANY project
- Should handle non-coding tasks (research, reminders, general questions)
- Should manage files anywhere on the system

**Solution: User-level config.** Claude Code supports two scopes:

| Scope | Location | When it loads |
|---|---|---|
| **User** | `~/.claude/` | Always, regardless of CWD |
| **Project** | `.claude/` in repo | Only when running from that directory |

OpenClaude installs everything at **user level** (`~/.claude/`), so identity,
skills, agents, memory, and rules follow the assistant everywhere. When the
daemon spawns a session to work on a specific project, it sets CWD to that
project's directory — picking up project-specific config on top of OpenClaude's
global identity.

**Working directory strategy for the daemon:**
- General questions → CWD = `$HOME` (no project context needed)
- Project-specific tasks → CWD = project directory (user says "work on my-webapp")
- The assistant can `cd` or use absolute paths for cross-project work
- Hindsight memory is CWD-independent (HTTP MCP server, always available)

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
- Single Docker command, embedded PostgreSQL (no external deps)
- Ollama support for fully local operation
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
| External dependencies | **Embedded PostgreSQL** | PG + Neo4j + API | Cloudflare | SQLite + Bun |
| Feature gating | **None** | Graph = $249/mo cloud | Enterprise | SOTA models = NC |

Hindsight provides the best independently verified retrieval accuracy, simplest
deployment, most permissive license, and richest memory model — with zero cost
and zero cloud dependency.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                  Claude Code + ClaudeClaw + Hindsight                 │
│                                                                     │
│  ┌──────────────┐  ┌───────────────┐  ┌─────────────────────────┐  │
│  │  ClaudeClaw   │  │  Hindsight    │  │  Native Claude Code      │  │
│  │  (plugin)     │  │  (MCP server) │  │                         │  │
│  │              │  │               │  │  - Skills                │  │
│  │  - Daemon    │  │  - Semantic   │  │  - Agents               │  │
│  │  - Telegram  │  │  - BM25      │  │  - Hooks                │  │
│  │  - Cron      │  │  - Graph     │  │  - Rules                │  │
│  │  - Heartbeat │  │  - Temporal  │  │  - Sessions             │  │
│  │  - Dashboard │  │  - Reranking │  │  - CLAUDE.md            │  │
│  │              │  │  - Entities  │  │                         │  │
│  │              │  │  - Mental    │  │                         │  │
│  │              │  │    models    │  │                         │  │
│  └──────────────┘  └───────────────┘  └─────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  ~/.claude/  (user-level — loads in EVERY session, any CWD)   │   │
│  │                                                               │   │
│  │    CLAUDE.md          — Agent identity + behavior rules       │   │
│  │    settings.json      — Permissions + hooks                   │   │
│  │    .mcp.json          — Hindsight MCP server entry            │   │
│  │                                                               │   │
│  │    skills/            — Personal workflows                    │   │
│  │    agents/            — Restricted subagents                  │   │
│  │    rules/             — Safety + formatting                   │   │
│  └──────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  CWD-dependent context (optional, per-project)                │   │
│  │                                                               │   │
│  │    General questions  → CWD = $HOME (no project context)     │   │
│  │    "Work on my-webapp" → CWD = ~/projects/my-webapp          │   │
│  │    Project .claude/   → layered on top of ~/.claude/         │   │
│  └──────────────────────────────────────────────────────────────┘   │
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
- Background daemon (launchd/systemd)
- Telegram adapter with streaming
- Cron scheduler with timezone support
- Heartbeat (periodic checklist review + proactive action)
- Web dashboard for monitoring

**Hindsight** (MCP server — advanced memory):
- **Retain**: store facts, experiences, and mental models
- **Recall**: 4 parallel strategies (semantic + BM25 + graph + temporal) + reranking
- **Reflect**: generate new insights from existing memories
- Entity resolution (deduplicate people, concepts, decisions)
- Knowledge graph with entity/temporal/causal links
- Biomimetic memory types: world facts, experiences, learned mental models
- Per-user isolation with custom metadata
- MCP-first: native integration with Claude Code
- Runs as Docker container with embedded PostgreSQL
- Optional: Ollama for fully local operation (no API key)

**Native Claude Code** (zero dependencies):
- Skills — reusable workflows
- Agents — restricted subagents
- Hooks — lifecycle automation
- Sessions — persistence and compaction
- CLAUDE.md + rules — identity and constraints

**OpenClaude** (config files installed to `~/.claude/`, not project-scoped):
- `~/.claude/CLAUDE.md` — agent identity (loads in every session, any CWD)
- `~/.claude/.mcp.json` — Hindsight MCP server (memory available everywhere)
- `~/.claude/skills/` — personal workflows (standup, research, etc.)
- `~/.claude/agents/` — restricted subagents
- `~/.claude/rules/` — safety + formatting
- `~/.claude/settings.json` — global permissions + hooks
- `scripts/setup.sh` — one-command install

## Project Structure

**Source repo** (what you clone/maintain):
```
openclaude/
  config/
    CLAUDE.md              # Agent identity, behavior, safety
    settings.json          # Permissions, hooks
    .mcp.json              # Hindsight MCP server entry

    skills/
      standup/SKILL.md     # Daily standup
      review/SKILL.md      # Code review workflow
      research/SKILL.md    # Deep research workflow
      remind/SKILL.md      # Set reminders / manage tasks

    agents/
      cron-worker.md       # Read-only agent for scheduled tasks
      researcher.md        # WebSearch + Read only
      coder.md             # Full tool access, project-scoped

    rules/
      safety.md            # Boundaries
      messaging.md         # Telegram formatting

  scripts/
    setup.sh               # Install deps + copy config to ~/.claude/
    uninstall.sh           # Clean up

  docs/
    setup.md               # Manual setup guide
    plans/                 # Architecture docs
```

**Installed location** (what actually runs):
```
~/.claude/
  CLAUDE.md                # ← copied from config/CLAUDE.md
  settings.json            # ← copied from config/settings.json
  .mcp.json                # ← copied from config/.mcp.json (Hindsight)

  skills/
    standup/SKILL.md       # ← copied from config/skills/
    review/SKILL.md
    research/SKILL.md
    remind/SKILL.md

  agents/
    cron-worker.md         # ← copied from config/agents/
    researcher.md
    coder.md

  rules/
    safety.md              # ← copied from config/rules/
    messaging.md
```

This means OpenClaude's identity, memory, skills, and rules load in **every
Claude Code session on the machine** — whether spawned by ClaudeClaw from
Telegram, opened interactively in a terminal, or triggered by a cron job.

**Custom runtime code: 0 lines.**

## Implementation Plan

### Phase 1: Hindsight Memory System (Day 1, morning)

**Goal:** Advanced memory running and accessible via MCP.

1. Start Hindsight:
   ```bash
   # With OpenAI embeddings (recommended for quality):
   export OPENAI_API_KEY=sk-xxx
   docker run --rm -d --name hindsight -p 8888:8888 -p 9999:9999 \
     -e HINDSIGHT_API_LLM_API_KEY=$OPENAI_API_KEY \
     -v $HOME/.hindsight:/home/hindsight/.pg0 \
     ghcr.io/vectorize-io/hindsight:latest

   # Or fully local with Ollama (no API key):
   docker run --rm -d --name hindsight -p 8888:8888 -p 9999:9999 \
     -e HINDSIGHT_API_LLM_PROVIDER=ollama \
     -e HINDSIGHT_API_LLM_BASE_URL=http://host.docker.internal:11434 \
     -v $HOME/.hindsight:/home/hindsight/.pg0 \
     ghcr.io/vectorize-io/hindsight:latest
   ```

2. Verify API is running: `curl http://localhost:8888/health`

3. Add to `~/.claude/.mcp.json` (user-level, available everywhere):
   ```json
   {
     "mcpServers": {
       "hindsight": {
         "type": "http",
         "url": "http://localhost:8888/mcp"
       }
     }
   }
   ```

4. Test in Claude Code session:
   - Retain: "Remember that our deployment uses blue-green strategy on AWS ECS"
   - Recall: "What do you know about our deployment?"
   - Reflect: "What patterns do you see in recent decisions?"

5. Verify Hindsight UI at `http://localhost:9999` — browse stored memories

**Validation:** Retain → recall round-trip works; entity resolution links related facts.

### Phase 2: ClaudeClaw + Telegram (Day 1, afternoon)

**Goal:** Telegram bot running via daemon with memory.

1. Install ClaudeClaw:
   ```bash
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw
   ```
2. Configure via setup wizard:
   - Telegram bot token (from @BotFather)
   - Heartbeat interval (30 min)
   - Security level (level 2 — edit access)
3. Start: `/claudeclaw:start`
4. Test: Telegram message → response that uses Hindsight memory

**Validation:** Telegram conversation with memory-augmented responses.

### Phase 3: Agent Configuration (Day 2, morning)

**Goal:** Identity, skills, agents, rules via `.claude/` files.

1. Write `config/CLAUDE.md` (installed to `~/.claude/CLAUDE.md`):
   - Agent name and identity
   - **General-purpose assistant** framing (not project-specific)
   - Core behavior rules
   - Telegram response formatting
   - Instruction to use Hindsight for memory (retain important facts, recall context)
   - **CWD awareness**: "When asked to work on a project, use Bash to cd to the
     project directory. For general questions, stay in $HOME."

2. Create skills:
   - `standup/SKILL.md` — git log summary (works in any project CWD)
   - `review/SKILL.md` — code review checklist
   - `research/SKILL.md` — deep research on any topic (web + memory)
   - `remind/SKILL.md` — set reminders, manage personal tasks

3. Create agents:
   - `cron-worker.md` — Read, Glob, Grep, Bash only (no writes)
   - `researcher.md` — Read, WebSearch, WebFetch only
   - `coder.md` — Full tool access, for project-specific coding tasks

4. Create rules:
   - `safety.md` — hard boundaries
   - `messaging.md` — Telegram formatting

5. Create `settings.json` with global permissions

6. Run `scripts/setup.sh` to copy all config to `~/.claude/`

**Validation:** `/standup` works, agents have correct tool restrictions.

### Phase 4: Cron + Heartbeat (Day 2, afternoon)

**Goal:** Scheduled tasks delivering to Telegram.

1. Configure ClaudeClaw heartbeat:
   - Active hours: 8am–10pm
   - Checklist: review recent activity, pending tasks
   - Target: Telegram chat

2. Add cron jobs:
   - Daily standup at 9am
   - Any other recurring tasks

3. Test: heartbeat tick → Telegram delivery

**Validation:** Cron fires and delivers without intervention.

### Phase 5: Setup Script + Docs (Day 3)

**Goal:** Reproducible one-command setup.

1. Write `scripts/setup.sh`:
   ```bash
   #!/bin/bash
   set -e

   SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

   # 1. Install OpenClaude config to user-level (~/.claude/)
   echo "Installing OpenClaude config to ~/.claude/ ..."
   mkdir -p ~/.claude/skills ~/.claude/agents ~/.claude/rules
   cp "$SCRIPT_DIR/config/CLAUDE.md"     ~/.claude/CLAUDE.md
   cp "$SCRIPT_DIR/config/settings.json" ~/.claude/settings.json
   cp "$SCRIPT_DIR/config/.mcp.json"     ~/.claude/.mcp.json
   cp -r "$SCRIPT_DIR/config/skills/"*   ~/.claude/skills/
   cp -r "$SCRIPT_DIR/config/agents/"*   ~/.claude/agents/
   cp -r "$SCRIPT_DIR/config/rules/"*    ~/.claude/rules/

   # 2. Hindsight — advanced memory (Docker must be running)
   echo "Starting Hindsight memory system..."
   docker run --rm -d --name hindsight -p 8888:8888 -p 9999:9999 \
     -e HINDSIGHT_API_LLM_PROVIDER=${HINDSIGHT_LLM_PROVIDER:-ollama} \
     -e HINDSIGHT_API_LLM_BASE_URL=${HINDSIGHT_LLM_URL:-http://host.docker.internal:11434} \
     -v $HOME/.hindsight:/home/hindsight/.pg0 \
     ghcr.io/vectorize-io/hindsight:latest

   # 3. ClaudeClaw — daemon + Telegram + cron
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw

   echo ""
   echo "OpenClaude installed to ~/.claude/ (user-level, active everywhere)"
   echo "Configure Telegram token, then run /claudeclaw:start"
   echo "Memory UI: http://localhost:9999"
   ```

2. Write `docs/setup.md`: prerequisites, step-by-step, troubleshooting

**Validation:** Fresh machine → working bot with memory in < 15 minutes.

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
| Slack channel | Wait for ClaudeClaw/Channels support, or write ~300-line bridge | 0 or 1 day |
| Discord | Already in ClaudeClaw — just configure | 10 minutes |
| Proactive messaging | ClaudeClaw exposes `send_message` | Config only |
| Native Channels (when stable) | Replace ClaudeClaw Telegram with official plugin | Config only |
| Switch memory provider | Swap Hindsight MCP entry for Mem0/Supermemory/ClawMem | Config only |

## Summary

| | v1 | v2 |
|---|---|---|
| **Lines of code** | 35,000 | 0 |
| **Test files** | 97 | 0 |
| **Production deps** | 15 | 0 |
| **External tools** | 0 (all custom) | 2 (ClaudeClaw + Hindsight) |
| **Setup time** | 30+ min | < 15 min |
| **Maintenance** | High | Near-zero |
| **Scope** | Project-tied | **General-purpose** (user-level `~/.claude/`) |
| **Memory benchmark** | Not tested | 91.4% LongMemEval |
| **Memory features** | Vector + BM25 (custom) | Semantic + BM25 + graph + temporal + reranking + entity resolution + mental models |
| **Telegram** | Custom grammY adapter | ClaudeClaw plugin |
| **Cron** | Custom croner scheduler | ClaudeClaw plugin |
| **Skills** | Custom loader | Native `~/.claude/skills/` (global) |
| **Sessions** | Custom session-map | Native Claude Code |
| **Multi-project** | Single CWD | CWD per task, identity everywhere |
