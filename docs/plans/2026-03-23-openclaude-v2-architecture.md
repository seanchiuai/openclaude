# OpenClaude v2 — Architecture & Implementation Plan

## Problem Statement

OpenClaude v1 rebuilds ~50% of what Claude Code now provides natively (skills,
sessions, subagents, routing, system prompts, MCP tools). The result is 35k lines
of code, 97 test files, and a maintenance burden that grows with every Claude Code
release.

## Landscape: What Already Exists

### Native Claude Code (March 2026)

- **Channels** (research preview): Telegram + Discord via plugin system. MCP-based,
  pushes events into running sessions. Pairing flow, sender allowlists.
  [Docs](https://code.claude.com/docs/en/channels)
- **Skills**: `.claude/skills/*/SKILL.md` with YAML frontmatter, auto-invocation,
  argument substitution, model override, subagent context isolation.
- **Agents**: `.claude/agents/*.md` with tool restrictions, model override, hooks,
  MCP server scoping, persistent memory.
- **Hooks**: 25+ lifecycle events (SessionStart, PreToolUse, PostToolUse, Stop, etc.)
  with command, HTTP, prompt, and agent-based implementations.
- **Plugins**: Distributable packages of skills + agents + hooks + MCP servers + settings.
- **Agent SDK**: Python/TypeScript library. Same tools as CLI. API key required (no Pro).
- **Sessions**: Built-in `--session-id` / `--resume`, transcripts, auto-compaction.
- **Memory**: Auto-memory (`MEMORY.md`), CLAUDE.md, `.claude/rules/`.

### Open Source Projects

| Project | Stars | What It Does | Runtime | Auth |
|---|---|---|---|---|
| [**ClaudeClaw**](https://github.com/moazbuilds/claudeclaw) | 369 | Claude Code plugin: daemon + cron + heartbeat + Telegram/Discord + web dashboard | Bun | Pro subscription |
| [**claude-code-telegram**](https://github.com/RichardAtCT/claude-code-telegram) | 1.1k | Python Telegram bot: SDK/CLI dual mode, SQLite sessions, webhooks, cron, voice | Python | API key or CLI auth |
| [**ClawMem**](https://github.com/yoloshii/ClawMem) | — | MCP memory server: hybrid RAG (BM25 + vector + graph), hooks integration, local LLM reranking | Bun | N/A |
| [**secure-openclaw**](https://github.com/ComposioHQ/secure-openclaw) | — | WhatsApp/Telegram/Signal/iMessage bridge + Agent SDK + 500 app integrations + sandboxed execution | Node | API key |

### Key Insight

**ClaudeClaw is already OpenClaude v2.** It's a Claude Code plugin that adds
daemon + cron + heartbeat + Telegram/Discord — running on Pro subscription with
zero API costs. ClawMem is already the vector memory MCP server with hybrid RAG.

## Decision: Telegram-only via composition

With Telegram as the only channel, there is **zero custom runtime code to write**.
ClaudeClaw handles Telegram natively. ClawMem handles memory. OpenClaude becomes
a configuration and personality layer — `.claude/` files only.

Slack can be added later if needed (either when ClaudeClaw adds it, when Claude
Code Channels adds it, or as a ~300-line standalone adapter).

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Session                          │
│                                                                     │
│  ┌──────────────────┐  ┌──────────────────┐                        │
│  │  ClaudeClaw       │  │   ClawMem         │                        │
│  │  (plugin)         │  │   (MCP server)    │                        │
│  │                  │  │                  │                        │
│  │  - Daemon        │  │  - BM25 + vector │                        │
│  │  - Telegram      │  │  - Graph search  │                        │
│  │  - Discord       │  │  - Hooks (auto-  │                        │
│  │  - Cron          │  │    inject context)│                        │
│  │  - Heartbeat     │  │  - Reranking     │                        │
│  │  - Web dashboard │  │  - Local LLMs    │                        │
│  │  - GLM fallback  │  │  - 28 MCP tools  │                        │
│  └──────────────────┘  └──────────────────┘                        │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  .claude/  (OpenClaude's contribution)                        │   │
│  │                                                               │   │
│  │    CLAUDE.md          — Agent identity + behavior rules       │   │
│  │    settings.json      — Permissions + env vars                │   │
│  │    .mcp.json          — ClawMem server entry                  │   │
│  │                                                               │   │
│  │    skills/                                                    │   │
│  │      standup/SKILL.md     — Daily standup                     │   │
│  │      review/SKILL.md      — Code review workflow              │   │
│  │      deploy/SKILL.md      — Deployment checklist              │   │
│  │      memory-flush/SKILL.md — Save context before exit         │   │
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

### What each component owns

**ClaudeClaw** (install as-is):
- Background daemon lifecycle (launchd/systemd)
- Telegram + Discord adapters
- Cron scheduler with timezone support
- Heartbeat system (periodic checklist review)
- Web dashboard for monitoring
- Model fallback (GLM when primary limit reached)
- Security levels (read-only → full access)

**ClawMem** (install as-is):
- Hybrid retrieval (BM25 + vector + graph traversal)
- Claude Code hooks (auto-inject context on every prompt)
- Decision extraction from session transcripts
- Handoff generation at session end
- Local embedding models (no API key needed)
- Cross-encoder reranking
- 28 MCP tools for agent-initiated retrieval

**OpenClaude** (what we create — config files only):
- `CLAUDE.md` — agent identity, behavior rules, safety constraints
- Skills — reusable workflows (standup, review, deploy, etc.)
- Agents — restricted execution contexts (cron-worker, researcher)
- Rules — safety boundaries, message formatting conventions
- MCP config — ClawMem server entry
- Settings — permission defaults

## Project Structure

```
openclaude/
  .claude/
    CLAUDE.md
    settings.json
    .mcp.json

    skills/
      standup/SKILL.md
      review/SKILL.md
      deploy/SKILL.md
      memory-flush/SKILL.md

    agents/
      cron-worker.md
      researcher.md

    rules/
      safety.md
      messaging.md

  docs/
    setup.md              # Installation guide
    plans/                # Architecture docs

  scripts/
    setup.sh              # One-command install: ClaudeClaw + ClawMem + config
```

**Custom code: 0 lines of TypeScript.** One shell script for setup.

## Implementation Plan

### Phase 1: Install + Configure ClaudeClaw (Day 1, morning)

**Goal:** Telegram bot running via ClaudeClaw daemon.

1. Install ClaudeClaw plugin:
   ```bash
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw
   ```
2. Run ClaudeClaw setup wizard — configure:
   - Telegram bot token (from @BotFather)
   - Heartbeat interval (e.g., 30 min)
   - Security level (e.g., level 2 — edit access)
   - Model selection
3. Start daemon: `/claudeclaw:start`
4. Test: send Telegram message → get Claude Code response

**Validation:** Round-trip Telegram conversation working.

### Phase 2: Install + Configure ClawMem (Day 1, afternoon)

**Goal:** Vector memory auto-injected into every Claude Code session.

1. Install ClawMem:
   ```bash
   npm install -g clawmem
   clawmem bootstrap ~/.openclaude/memory --name openclaude
   clawmem setup hooks
   clawmem setup mcp
   ```
2. Configure embedding provider:
   - Local (no API key): node-llama-cpp with EmbeddingGemma-300M
   - Or cloud: OpenAI text-embedding-3-small
3. Test: start a Claude Code session, verify context auto-injection on prompt
4. Test: ask Claude to remember something, verify it persists across sessions

**Validation:** Memory search returns relevant results; context appears in new sessions.

### Phase 3: Agent Configuration (Day 2)

**Goal:** Agent identity, skills, and rules via `.claude/` files.

1. Write `CLAUDE.md`:
   - Agent name and identity
   - Core behavior rules
   - Response formatting for Telegram
   - Tool usage preferences
   - Safety constraints

2. Create skills:
   - `standup/SKILL.md` — review recent git commits, summarize
   - `review/SKILL.md` — code review workflow with checklist
   - `deploy/SKILL.md` — deployment checklist and verification
   - `memory-flush/SKILL.md` — save important session context to ClawMem

3. Create agents:
   - `cron-worker.md` — restricted tools (Read, Glob, Grep, Bash), no Edit/Write.
     Used for scheduled read-only tasks.
   - `researcher.md` — Read + WebSearch + WebFetch only. For deep research without
     code changes.

4. Create rules:
   - `safety.md` — what the agent must never do
   - `messaging.md` — how to format replies for Telegram (markdown, length limits)

5. Create `settings.json` with permission defaults
6. Create `.mcp.json` with ClawMem entry

7. Test: `/standup` skill, cron-worker delegation, rule enforcement

**Validation:** All skills invoke correctly; agents have proper tool restrictions.

### Phase 4: Cron + Heartbeat Setup (Day 2, afternoon)

**Goal:** Scheduled tasks running and delivering results to Telegram.

1. Configure ClaudeClaw heartbeat:
   - Interval: 30 minutes (or custom)
   - Active hours: 8am–10pm
   - Checklist prompt: review recent activity, pending tasks, alerts
   - Delivery target: Telegram chat

2. Add cron jobs via ClaudeClaw:
   - Daily standup (9am): invoke `/standup` skill
   - Hourly health check: verify services, report anomalies
   - Weekly review: summarize week's activity

3. Test: wait for heartbeat tick → verify delivery to Telegram
4. Test: manually trigger cron job → verify execution and delivery

**Validation:** Scheduled tasks run and deliver results without intervention.

### Phase 5: Setup Script + Documentation (Day 3)

**Goal:** Reproducible one-command setup.

1. Write `scripts/setup.sh`:
   ```bash
   #!/bin/bash
   # Install ClaudeClaw
   claude plugin marketplace add moazbuilds/claudeclaw
   claude plugin install claudeclaw

   # Install ClawMem
   npm install -g clawmem
   clawmem bootstrap ~/.openclaude/memory --name openclaude
   clawmem setup hooks
   clawmem setup mcp

   # Copy .claude/ config files
   cp -r .claude/ ~/.claude/  # or symlink

   echo "Run /claudeclaw:start in a Claude Code session to begin."
   ```

2. Write `docs/setup.md`:
   - Prerequisites (Claude Code, Bun, Telegram bot token)
   - Step-by-step setup
   - Configuration options
   - Troubleshooting

3. Test: fresh machine → run setup → working bot

**Validation:** Clean setup in < 10 minutes.

## Migration from v1

1. Export v1 memory: `clawmem bootstrap ~/.openclaude/memory --name openclaude`
2. Copy v1 skills to `.claude/skills/` (rename `SKILL.md` files if format differs)
3. Run `scripts/setup.sh`
4. Delete all of `src/` — no longer needed
5. Delete unused deps from `package.json`

## What Gets Deleted from v1

**All of `src/`** — 35k lines, 97 test files:

- `src/engine/` — spawn, pool, sessions, system-prompt, subagents, model
- `src/gateway/` — HTTP server, auth, rate limiting, service management
- `src/router/` — dispatch logic
- `src/channels/` — Telegram + Slack adapters
- `src/cron/` — scheduler, heartbeat, store
- `src/memory/` — embeddings, hybrid search, SQLite, all providers
- `src/skills/` — loader, commands
- `src/mcp/` — gateway tools server
- `src/tools/` — MCP tool implementations
- `src/config/` — schema, loader, types
- `src/cli/` — command handlers
- `src/wizard/` — onboarding
- `src/logging/` — logger, diagnostics
- `src/integration/` — integration tests

**Keep:**
- `.claude/` — all config files (this IS the project now)
- `docs/` — architecture plans, setup guide
- `scripts/setup.sh` — installation script
- `CLAUDE.md` (root) — project-level instructions

## Future: Adding Slack

When Slack is needed, three options in priority order:

1. **ClaudeClaw adds Slack support** — just configure it (0 lines)
2. **Claude Code Channels adds Slack** — use native plugin (0 lines)
3. **Standalone Slack bridge** — ~300 lines:
   ```typescript
   // Minimal Slack → Claude Code bridge
   const app = new App({ token, appToken, socketMode: true })
   const sessions = new Map<string, string>()  // channelKey → sessionId

   app.message(async ({ message, say }) => {
     const key = `${message.channel}:${message.user}`
     const sessionId = sessions.get(key) ?? crypto.randomUUID()
     const flag = sessions.has(key) ? '--resume' : '--session-id'

     const result = await spawn('claude', ['-p', flag, sessionId,
       '--output-format', 'stream-json'], { input: message.text })

     sessions.set(key, sessionId)
     await say(extractResult(result))
   })
   ```

## Dependencies

```
Production: none (all config files)

External (installed separately):
  ClaudeClaw plugin        # Daemon + Telegram/Discord + cron
  ClawMem                  # Vector memory MCP server

Requires:
  Claude Code CLI          # The AI engine
  Bun                      # Required by ClaudeClaw and ClawMem
  Node.js                  # For setup script
```

## Summary

| | OpenClaude v1 | OpenClaude v2 |
|---|---|---|
| **Lines of code** | 35,000 | 0 (config files only) |
| **Test files** | 97 | 0 (nothing to test) |
| **Dependencies** | 15 | 0 (external tools) |
| **Setup time** | 30+ minutes | < 10 minutes |
| **Maintenance** | High (every Claude Code update) | Near-zero |
| **Telegram** | Custom adapter | ClaudeClaw |
| **Memory** | Custom hybrid search | ClawMem |
| **Cron** | Custom scheduler | ClaudeClaw |
| **Skills** | Custom loader | Native `.claude/skills/` |
| **Sessions** | Custom management | Native Claude Code |
