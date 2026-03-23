# OpenClaude v2 — Architecture & Implementation Plan

## Problem Statement

OpenClaude v1 rebuilds ~50% of what Claude Code now provides natively (skills,
sessions, subagents, routing, system prompts, MCP tools). The result is 35k lines
of code, 97 test files, and a maintenance burden that grows with every Claude Code
release.

## Landscape: What Already Exists

Before proposing a build plan, here's what's already shipping:

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
| [**claude-mem**](https://github.com/thedotmack/claude-mem) | — | Auto-capture + compress + inject session memory via Claude Code plugin | — | N/A |

### Key Insight

**ClaudeClaw is already OpenClaude v2.** It's a Claude Code plugin that adds
daemon + cron + heartbeat + Telegram/Discord — running on Pro subscription with
zero API costs. ClawMem is already the vector memory MCP server with hybrid RAG.

## Decision: Build vs. Compose vs. Fork

### Option A: Build from scratch (original plan)

- ~3-5k lines of new code
- 17 days of implementation
- Reinvents what ClaudeClaw and ClawMem already ship
- Only advantage: Slack support, Node.js (vs Bun)

### Option B: Compose existing tools (recommended)

- Install ClaudeClaw plugin for daemon + channels + cron
- Install ClawMem for vector memory
- Write only the **glue** that's missing: Slack adapter, config unification
- ~500-1000 lines of new code
- 3-5 days of implementation

### Option C: Fork ClaudeClaw + extend

- Fork ClaudeClaw, add Slack support + ClawMem integration
- Contribute upstream where possible
- ~1-2k lines of new code
- 5-8 days of implementation

**Recommendation: Option B** — compose first, fork only if composition hits walls.

## Proposed Architecture (Option B)

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Claude Code Session                          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │  ClaudeClaw   │  │   ClawMem    │  │   openclaude plugin      │  │
│  │  (plugin)     │  │   (MCP)      │  │   (Slack + glue)         │  │
│  │              │  │              │  │                          │  │
│  │  - Daemon    │  │  - Vector    │  │  - Slack adapter         │  │
│  │  - Telegram  │  │    search    │  │  - Config bridge         │  │
│  │  - Discord   │  │  - BM25      │  │  - Unified setup wizard  │  │
│  │  - Cron      │  │  - Graph     │  │                          │  │
│  │  - Heartbeat │  │  - Hooks     │  │                          │  │
│  │  - Dashboard │  │  - Reranking │  │                          │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  .claude/                                                     │   │
│  │    CLAUDE.md          — Agent identity + behavior rules       │   │
│  │    settings.json      — Permissions                           │   │
│  │    skills/            — Custom playbooks (standup, etc.)      │   │
│  │    agents/            — Restricted agents (cron-worker, etc.) │   │
│  │    rules/             — Safety, messaging conventions         │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### What each component owns

**ClaudeClaw** (existing plugin, install as-is):
- Background daemon lifecycle
- Telegram + Discord adapters
- Cron scheduler with timezone support
- Heartbeat system
- Web dashboard
- Model fallback (GLM)
- Security levels

**ClawMem** (existing MCP server, install as-is):
- Hybrid retrieval (BM25 + vector + graph)
- Session hooks (auto-inject context on every prompt)
- Decision extraction from transcripts
- Handoff generation at session end
- Local embedding models (no API key needed)
- Cross-encoder reranking

**openclaude plugin** (what we build):
- **Slack adapter** — ClaudeClaw only has Telegram + Discord. We add Slack via
  `@slack/bolt` Socket Mode, exposing it as a ClaudeClaw-compatible channel.
- **Config bridge** — Unified `~/.openclaude/config.json` that generates configs
  for both ClaudeClaw and ClawMem. Single source of truth.
- **Setup wizard** — `openclaude setup` that installs ClaudeClaw + ClawMem,
  configures all three, and validates the setup.
- **Custom skills** — `.claude/skills/` for project-specific workflows.
- **Custom agents** — `.claude/agents/` for restricted execution contexts.

## What OpenClaude Becomes

OpenClaude is no longer a runtime. It's a **configuration layer + Slack adapter**:

```
openclaude/
  .claude/
    CLAUDE.md                  # Agent identity, behavior, safety
    settings.json              # Permissions
    .mcp.json                  # ClawMem + any custom MCP servers

    skills/
      standup/SKILL.md         # Daily standup
      review/SKILL.md          # Code review workflow
      deploy/SKILL.md          # Deployment checklist

    agents/
      cron-worker.md           # Restricted agent for scheduled tasks
      researcher.md            # Read-only research agent

    rules/
      safety.md                # Boundaries and constraints
      messaging.md             # Channel reply formatting

  src/
    slack-channel/             # Slack adapter (ClaudeClaw extension)
      index.ts                 # @slack/bolt Socket Mode
      types.ts                 # Message types
    config-bridge/             # Unified config → ClaudeClaw + ClawMem
      index.ts
      schema.ts                # Zod schema
    cli.ts                     # setup wizard + status

  package.json
  tsconfig.json
```

**Estimated size: ~800 lines** (down from 35,000).

## Implementation Plan

### Phase 1: Foundation (Day 1)

**Goal:** Working ClaudeClaw + ClawMem installation.

1. Install ClaudeClaw: `claude plugin marketplace add moazbuilds/claudeclaw`
2. Install ClawMem: `npm install -g clawmem && clawmem setup hooks && clawmem setup mcp`
3. Configure ClaudeClaw: Telegram bot token, heartbeat interval, security level
4. Configure ClawMem: embedding provider, vault location
5. Test: send Telegram message → get response with memory context

**Validation:** Telegram conversation with persistent memory working end-to-end.

### Phase 2: Claude Code Configuration (Day 2)

**Goal:** Agent identity and skills via native `.claude/` files.

1. Write `CLAUDE.md` — agent identity, behavior rules, safety constraints
2. Create skills: standup, review, deploy, memory-flush
3. Create agents: cron-worker (restricted tools), researcher (read-only)
4. Create rules: safety.md, messaging.md
5. Create `.mcp.json` with ClawMem server entry
6. Create `settings.json` with permission defaults
7. Test: `/standup` skill invocation, cron-worker agent delegation

**Validation:** All skills and agents work in a normal `claude` session.

### Phase 3: Slack Adapter (Day 3-4)

**Goal:** Slack messages reach Claude Code through ClaudeClaw's daemon.

1. Research ClaudeClaw's channel extension API
2. If extensible: write Slack adapter as ClaudeClaw channel plugin
3. If not extensible: write standalone Slack bridge that posts to ClaudeClaw's API
4. Fallback: write minimal standalone daemon with only Slack + spawn logic
5. Tests for Slack adapter

**Validation:** Slack message → Claude Code response in Slack thread.

### Phase 4: Config Bridge + Setup Wizard (Day 4-5)

**Goal:** Single config file, one-command setup.

1. `src/config-bridge/schema.ts` — Zod schema for unified config
2. `src/config-bridge/index.ts` — Generate ClaudeClaw + ClawMem configs from unified config
3. `src/cli.ts` — `openclaude setup` wizard:
   - Detect/install ClaudeClaw plugin
   - Detect/install ClawMem
   - Configure Telegram/Discord/Slack tokens
   - Configure memory embedding provider
   - Generate all config files
   - Validate setup
4. `openclaude status` — show daemon health, memory stats, channel status

**Validation:** `openclaude setup` → fully configured system in < 5 minutes.

### Phase 5: Polish + Documentation (Day 5)

**Goal:** Production-ready with clear documentation.

1. Error handling for missing dependencies
2. README with quickstart
3. Troubleshooting guide
4. Integration tests (Telegram mock → ClaudeClaw → response)

## Key Decisions

### Why compose instead of build?

| Factor | Build from scratch | Compose existing |
|---|---|---|
| Code to write | 3-5k lines | ~800 lines |
| Time | 17 days | 5 days |
| Telegram/Discord | Build from scratch | Already working |
| Memory/RAG | Build from scratch | Already working (28 MCP tools) |
| Cron/heartbeat | Build from scratch | Already working |
| Web dashboard | Not planned | Free (ClaudeClaw) |
| Maintenance | All on us | Shared with upstream |
| Risk | Medium (new code) | Low (proven projects) |

### Why not just use ClaudeClaw directly?

You could! OpenClaude adds three things:
1. **Slack support** (ClaudeClaw only has Telegram + Discord)
2. **Vector memory** (ClaudeClaw uses native CLAUDE.md memory only)
3. **Unified configuration** (one config instead of three separate tool configs)

If you don't need Slack and flat-file memory is sufficient, just install ClaudeClaw
and ClawMem separately. OpenClaude is the opinionated composition layer.

### What if ClaudeClaw doesn't support channel extensions?

Fallback plan: write a minimal standalone Slack daemon (~300 lines) that:
1. Receives Slack messages via `@slack/bolt` Socket Mode
2. Spawns `claude -p` with `--session-id` / `--resume`
3. Sends response back to Slack
4. Stores session map in JSON file

This is the irreducible minimum. No process pool, no cron, no memory — those come
from ClaudeClaw and ClawMem.

### When does native Claude Code Channels replace this?

When all of these are true:
- Channels exits research preview (stable API)
- Slack support added (currently Telegram + Discord only)
- Daemon/headless mode (currently requires open terminal)
- Node.js support (currently Bun-only)

At that point, OpenClaude's channel adapters can be deleted entirely, and the
project becomes purely `.claude/` configuration files.

## Dependencies (v2)

```
Production:
  @slack/bolt              # Slack adapter (only new dep)
  zod                      # Config validation

External (installed separately):
  ClaudeClaw plugin        # Daemon + Telegram/Discord + cron
  ClawMem                  # Vector memory MCP server

Dev:
  typescript
  vitest
  tsdown
  oxlint
  oxfmt
```

**Total new production deps: 2** (down from 15).

## Migration Path from v1

1. `openclaude setup` — installs ClaudeClaw + ClawMem
2. Migrate `~/.openclaude/config.json` → new unified format (automated)
3. Migrate `~/.openclaude/memory/` → ClawMem vault (run `clawmem bootstrap ~/.openclaude/memory`)
4. Migrate `~/.openclaude/skills/` → `.claude/skills/` (copy SKILL.md files)
5. Delete `~/.openclaude/` except config + memory vault
6. Delete all of `src/` except Slack adapter and config bridge

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ClaudeClaw abandoned/unmaintained | Low | High | Fork; it's 369 stars and active |
| ClawMem incompatible with our needs | Low | Medium | It's an MCP server; can swap for our own |
| ClaudeClaw doesn't support Slack extension | Medium | Low | Standalone Slack daemon fallback (~300 lines) |
| Claude Code Channels replaces everything | Medium | Positive | Less code to maintain; migrate when stable |
| Bun dependency (ClaudeClaw) | Low | Low | Bun is stable; or fork to Node |

## Summary

**OpenClaude v1**: 35k lines, custom runtime wrapping Claude Code.
**OpenClaude v2**: ~800 lines, configuration layer composing ClaudeClaw + ClawMem + Slack.

The 97% reduction in code comes from recognizing that the ecosystem caught up.
The right move is to compose, not compete.
