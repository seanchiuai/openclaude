# OpenClaude v2 — Architecture & Implementation Plan

## Problem Statement

OpenClaude v1 rebuilds ~50% of what Claude Code now provides natively (skills,
sessions, subagents, routing, system prompts, MCP tools). The result is 35k lines
of code, 97 test files, and a maintenance burden that grows with every Claude Code
release.

## Native Feature Evaluation

Before reaching for external tools, evaluate every built-in Claude Code feature:

| Feature | What it does | Sufficient? | Why / Why not |
|---|---|---|---|
| **Skills** (`.claude/skills/`) | Reusable workflows with YAML frontmatter, auto-invocation, args | **Yes** | Replaces `src/skills/` entirely |
| **Agents** (`.claude/agents/`) | Subagents with tool restrictions, model override, hooks | **Yes** | Replaces `src/engine/subagent-*` |
| **Hooks** (25+ events) | Shell/HTTP/prompt automation at lifecycle points | **Yes** | Replaces `src/router/` dispatch |
| **Sessions** (`--session-id`/`--resume`) | Built-in persistence, transcripts, compaction | **Yes** | Replaces `src/engine/session-*` |
| **CLAUDE.md** + rules | Persistent instructions, path-scoped rules, imports | **Yes** | Replaces `src/engine/system-prompt.ts` |
| **Auto-memory** (`MEMORY.md`) | 200 lines auto-loaded, topic files on demand, cross-session | **No** | 200-line limit, no semantic search, no similarity matching. Memory is core to a personal assistant — use ClawMem for advanced retrieval |
| **/loop** | Recurring prompts at intervals | **No** | Dies on terminal close. 3-day expiry. Session-scoped only |
| **Channels** (Telegram) | MCP-based message bridge | **No** | Research preview. Requires open terminal. No daemon mode. Bun-only |
| **Desktop scheduled tasks** | Recurring tasks in desktop app | **No** | Requires desktop app open. Not unattended |
| **Plugins** | Package skills/agents/hooks/MCP | **Yes** (for distribution) | Cannot run background daemons |

### What native features CANNOT do

Three things require external tooling:

1. **Always-on daemon** — Claude Code has no headless mode. `/loop` and scheduled
   tasks die when the session/app closes.
2. **Telegram without open terminal** — Channels require `--channels` flag in an
   active session. No background message handling.
3. **Durable cron with delivery** — No native way to run a prompt at 9am and send
   the result to Telegram while unattended.

### Why advanced memory matters

Memory is the core differentiator for a personal AI assistant. Native auto-memory
is a flat file with a 200-line auto-load limit and no search capability. For an
assistant that accumulates knowledge over weeks and months, this falls short:

- **No semantic search** — can't find "that conversation about deployment" by meaning
- **No similarity matching** — can't surface related past decisions
- **200-line ceiling** — topic files exist but Claude must guess which to load
- **No temporal awareness** — can't prioritize recent vs. old memories
- **No cross-reference** — can't link related concepts or trace decision chains

[ClawMem](https://github.com/yoloshii/ClawMem) provides all of this:
- Hybrid search: BM25 + vector + graph traversal
- Temporal decay (recent memories rank higher)
- Cross-encoder reranking for precision
- Decision extraction from session transcripts
- Handoff generation (session continuity across restarts)
- 28 MCP tools for granular retrieval
- Hooks: auto-inject context on every prompt, capture decisions on stop
- Local embedding models — no API key required

## Landscape: External Tools Needed

| Project | What we use it for | Why |
|---|---|---|
| [**ClaudeClaw**](https://github.com/moazbuilds/claudeclaw) | Daemon + Telegram + cron + heartbeat | Headless daemon on Pro subscription |
| [**ClawMem**](https://github.com/yoloshii/ClawMem) | Advanced memory with hybrid RAG | Semantic search, temporal decay, decision extraction |

Two external dependencies. Both install in minutes.

### Why not claude-code-telegram?

[claude-code-telegram](https://github.com/RichardAtCT/claude-code-telegram) (1.1k
stars) is more mature but is a Python app with its own session management, auth
layer, and tool monitoring. It duplicates what Claude Code already does natively.
ClaudeClaw is a plugin that extends Claude Code rather than wrapping it.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                   Claude Code + ClaudeClaw + ClawMem                  │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  ClaudeClaw   │  │   ClawMem    │  │  Native Claude Code       │  │
│  │  (plugin)     │  │   (MCP)      │  │                          │  │
│  │              │  │              │  │  - Skills                 │  │
│  │  - Daemon    │  │  - BM25      │  │  - Agents                │  │
│  │  - Telegram  │  │  - Vector    │  │  - Hooks                 │  │
│  │  - Cron      │  │  - Graph     │  │  - Rules                 │  │
│  │  - Heartbeat │  │  - Reranking │  │  - Sessions              │  │
│  │  - Dashboard │  │  - Hooks     │  │  - CLAUDE.md             │  │
│  │              │  │  - 28 tools  │  │                          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  .claude/  (OpenClaude's contribution)                        │   │
│  │                                                               │   │
│  │    CLAUDE.md          — Agent identity + behavior rules       │   │
│  │    settings.json      — Permissions + hooks                   │   │
│  │    .mcp.json          — ClawMem server entry                  │   │
│  │                                                               │   │
│  │    skills/                                                    │   │
│  │      standup/SKILL.md     — Daily standup                     │   │
│  │      review/SKILL.md      — Code review workflow              │   │
│  │      deploy/SKILL.md      — Deployment checklist              │   │
│  │                                                               │   │
│  │    agents/                                                    │   │
│  │      cron-worker.md   — Restricted agent for scheduled tasks  │   │
│  │      researcher.md    — Read-only research agent              │   │
│  │                                                               │   │
│  │    rules/                                                     │   │
│  │      safety.md        — Boundaries and constraints            │   │
│  │      messaging.md     — Channel reply formatting              │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Component responsibilities

**ClaudeClaw** (plugin — daemon + channels + scheduling):
- Background daemon (launchd/systemd)
- Telegram adapter
- Cron scheduler with timezone support
- Heartbeat (periodic checklist review)
- Web dashboard

**ClawMem** (MCP server — advanced memory):
- Hybrid retrieval: BM25 + vector embeddings + graph traversal
- Claude Code hooks: auto-inject context on every prompt, capture decisions on stop
- Decision extraction from session transcripts
- Handoff generation at session end (continuity across restarts)
- Local embedding models (no API key needed)
- Cross-encoder reranking for precision
- Temporal decay (recent memories rank higher)
- 28 MCP tools for granular agent-initiated retrieval

**Native Claude Code** (zero dependencies):
- Skills — reusable workflows
- Agents — restricted subagents
- Hooks — lifecycle automation
- Sessions — persistence and compaction
- CLAUDE.md + rules — identity and constraints

**OpenClaude** (config files only):
- `.claude/CLAUDE.md` — agent identity
- `.claude/.mcp.json` — ClawMem server entry
- `.claude/skills/` — custom workflows
- `.claude/agents/` — restricted contexts
- `.claude/rules/` — safety + formatting
- `.claude/settings.json` — permissions + hooks
- `scripts/setup.sh` — one-command install

## Project Structure

```
openclaude/
  .claude/
    CLAUDE.md              # Agent identity, behavior, safety
    settings.json          # Permissions, hooks
    .mcp.json              # ClawMem server entry

    skills/
      standup/SKILL.md     # Review git commits, summarize
      review/SKILL.md      # Code review workflow
      deploy/SKILL.md      # Deployment checklist

    agents/
      cron-worker.md       # Read-only agent for scheduled tasks
      researcher.md        # WebSearch + Read only

    rules/
      safety.md            # Boundaries
      messaging.md         # Telegram formatting

  scripts/
    setup.sh               # Install ClaudeClaw + ClawMem + configure

  docs/
    setup.md               # Manual setup guide
    plans/                 # Architecture docs
```

**Custom runtime code: 0 lines.**

## Implementation Plan

### Phase 1: ClaudeClaw + Telegram (Day 1, morning)

**Goal:** Telegram bot running via daemon.

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
4. Test: Telegram message → Claude Code response

**Validation:** Round-trip Telegram conversation working.

### Phase 2: ClawMem Memory System (Day 1, afternoon)

**Goal:** Advanced vector memory auto-injected into every session.

1. Install ClawMem:
   ```bash
   npm install -g clawmem
   clawmem bootstrap ~/.openclaude/memory --name openclaude
   clawmem setup hooks    # SessionStart, UserPromptSubmit, Stop, PreCompact
   clawmem setup mcp      # 28 tools for agent-initiated retrieval
   ```
2. Configure embedding provider:
   - Local (no API key): node-llama-cpp with EmbeddingGemma-300M (~400MB)
   - Or cloud: OpenAI text-embedding-3-small (if API key available)
3. Add `.mcp.json` entry for ClawMem server
4. Test: ask Claude to remember something → verify it persists
5. Test: semantic search — ask about a topic from a previous session

**Validation:** Memory auto-injects on prompt; semantic search returns relevant results.

### Phase 3: Agent Configuration (Day 2, morning)

**Goal:** Identity, skills, agents, rules via `.claude/` files.

1. Write `.claude/CLAUDE.md`:
   - Agent name and identity
   - Core behavior rules (concise, no fluff)
   - Telegram response formatting (markdown, length limits)
   - Tool preferences

2. Create skills (only what you'll actually use):
   - `standup/SKILL.md` — git log summary
   - `review/SKILL.md` — code review checklist

3. Create agents:
   - `cron-worker.md` — Read, Glob, Grep, Bash only (no writes)
   - `researcher.md` — Read, WebSearch, WebFetch only

4. Create rules:
   - `safety.md` — hard boundaries
   - `messaging.md` — Telegram formatting

5. Create `settings.json` with permissions

6. Test skills and agents in a normal `claude` session

**Validation:** `/standup` works, agents have correct tool restrictions.

### Phase 4: Cron + Heartbeat (Day 2, afternoon)

**Goal:** Scheduled tasks delivering to Telegram.

1. Configure ClaudeClaw heartbeat:
   - Active hours: 8am–10pm
   - Checklist: recent activity, pending tasks
   - Target: Telegram chat

2. Add cron jobs:
   - Daily standup at 9am
   - Any other recurring tasks

3. Test: wait for tick → verify Telegram delivery

**Validation:** Cron fires and delivers without intervention.

### Phase 5: Setup Script + Docs (Day 3)

**Goal:** Reproducible setup.

1. Write `scripts/setup.sh`:
   ```bash
   #!/bin/bash
   set -e

   # ClaudeClaw — daemon + Telegram + cron
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw

   # ClawMem — advanced memory
   npm install -g clawmem
   clawmem bootstrap ~/.openclaude/memory --name openclaude
   clawmem setup hooks
   clawmem setup mcp

   echo "Done. Run /claudeclaw:start in Claude Code to begin."
   ```

2. Write `docs/setup.md`: prerequisites, step-by-step, troubleshooting

**Validation:** Fresh machine → working bot in < 10 minutes.

## What Gets Deleted from v1

**All of `src/`** — 35k lines, 97 test files. Every module:

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

If needs grow beyond what's built here:

| Need | Solution | Effort |
|---|---|---|
| Slack channel | Wait for ClaudeClaw/Channels support, or write ~300-line bridge | 0 or 1 day |
| Discord | Already in ClaudeClaw — just configure | 10 minutes |
| Proactive messaging from code | ClaudeClaw exposes `send_message` | Config only |
| Native Channels (when stable) | Replace ClaudeClaw's Telegram with official plugin | Config only |

## Summary

| | v1 | v2 |
|---|---|---|
| **Lines of code** | 35,000 | 0 |
| **Test files** | 97 | 0 |
| **Production deps** | 15 | 0 |
| **External tools** | 0 (all custom) | 2 (ClaudeClaw + ClawMem) |
| **Setup time** | 30+ min | < 10 min |
| **Maintenance** | High | Near-zero |
| **Memory** | Custom vector search (6 providers) | ClawMem (BM25 + vector + graph + reranking) |
| **Telegram** | Custom grammY adapter | ClaudeClaw plugin |
| **Cron** | Custom croner scheduler | ClaudeClaw plugin |
| **Skills** | Custom loader | Native `.claude/skills/` |
| **Sessions** | Custom session-map | Native Claude Code |
