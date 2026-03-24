# OpenClaude v2 — Implementation Gameplan

> **Note:** The memory system (Patch 4) was redesigned after this document was written.
> The Stop hook + `auto-retain.sh` approach was replaced with a SessionEnd hook + nightly cron.
> See `2026-03-23-memory-pipeline-redesign.md` for the current memory architecture.

## Project Name

`openclaude-v2-migration`

## Problem Statement

OpenClaude v1 is 35k lines of custom TypeScript (154 modules, 96 test files, 16 dependencies) that duplicates ~50% of what Claude Code now provides natively — skills, agents, hooks, sessions, system prompts, MCP tools. Every Claude Code release risks breaking our custom session management, process pool, and routing layer. We need to migrate to a thin configuration layer that delegates to Claude Code's native features, ClaudeClaw for daemon/Telegram, and Hindsight for advanced memory.

## Solution Summary

Replace all custom runtime code with: (1) self-contained agent directories under `~/.openclaude/agents/<name>/` where each agent has its own `.claude/` config + `workspace/` identity files, (2) Hindsight Docker containers for semantic memory with MCP integration, (3) ClaudeClaw plugin for daemon mode + Telegram, (4) ~300 lines of bash scripts for operational tasks (setup, health checks, memory governance, export/import). The result is 0 lines of custom runtime code, 0 production dependencies, and agents that work both interactively (`cd agent-dir && claude`) and via daemon (ClaudeClaw spawns `claude -p` with CWD = agent dir).

## Mergability Strategy

### Feature Flagging Strategy

Not applicable. This migration replaces an entire runtime — there's no gradual rollout or per-org gating. The cutover is: create new agent directories + config, then delete `src/`. The old and new systems can coexist during development since v2 lives entirely in `templates/` and `scripts/` (no overlap with `src/`).

### Patch Ordering Strategy

Early patches create all templates, scripts, and config files — pure additive, no behavior change to v1. Middle patches wire up Hindsight + ClaudeClaw integration. The final patch deletes `src/`, tests, and build config. This means v1 remains fully functional until the last patch.

## Current State Analysis

**What exists (v1):**
- `src/` — 12 subsystems (engine, gateway, router, channels, cron, memory, skills, mcp, tools, config, cli, wizard) across 154 `.ts` files
- `src/engine/` — Custom Claude Code spawning, process pool (max 4), session management via `sessions-map.json`
- `src/memory/` — 56 files: hybrid vector/BM25 search, SQLite + sqlite-vec, temporal decay, MMR reranking, batch processing
- `src/gateway/` — HTTP server (Hono), auth, launchd/systemd daemon lifecycle, PID management
- `src/channels/` — grammY (Telegram) + Slack bolt adapters with streaming, typing indicators, backoff
- `src/cron/` — croner-based scheduler, heartbeat system, persistent store
- `src/router/` — Dispatch logic (gateway commands → skills → cron → user messages)
- `src/skills/` — Custom YAML-frontmatter skill loader
- 96 test files, 16 production dependencies
- Build: tsdown → 3 ESM entry points (cli, gateway, mcp)

**What exists (upstream reference):**
- `openclaw-source/` — Full OpenClaw repo with workspace patterns (IDENTITY.md, SOUL.md, AGENTS.md, USER.md, TOOLS.md), 120 scripts, 54 skills

**What doesn't exist yet (v2):**
- `templates/` — Workspace + Claude Code config templates
- `scripts/` — Operational bash scripts
- No Hindsight deployment
- No ClaudeClaw configuration
- No agent directories under `~/.openclaude/agents/`

## Required Changes

### New directories and files to create

**`templates/workspace/`** — Agent identity templates (copied from OpenClaw patterns):

| File | Purpose |
|------|---------|
| `IDENTITY.md` | Agent name, creature type, vibe, emoji (placeholder) |
| `SOUL.md` | Persona, tone, values, boundaries |
| `AGENTS.md` | Operating rules, memory policy (incl. Hindsight `retain` discipline), red lines |
| `USER.md` | Human's name, timezone, preferences (placeholder) |
| `TOOLS.md` | Local environment: SSH hosts, devices, services (placeholder) |
| `HEARTBEAT.md` | Periodic checklist for proactive check-ins |
| `MEMORY.md` | Empty curated cheat sheet (agent populates over time) |

**`templates/claude/`** — Claude Code configuration:

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Bridge file with `@import ../workspace/*.md` directives |
| `.mcp.json` | Hindsight MCP server entry (templated port + bank) |
| `settings.json` | Default permissions + hooks (auto-retain, memory-size check) |
| `skills/bootstrap/SKILL.md` | One-time onboarding conversation |
| `skills/standup/SKILL.md` | Daily git summary via absolute paths |
| `skills/research/SKILL.md` | Deep web + Hindsight memory research |
| `skills/remind/SKILL.md` | Set reminders / manage tasks |
| `agents/cron-worker.md` | Subagent: Read + Write scoped to `workspace/memory/` |
| `agents/researcher.md` | Subagent: WebSearch + Read only |
| `agents/coder.md` | Subagent: Full tool access for project work |
| `rules/safety.md` | Hard boundaries (no exfiltration, ask before destructive ops) |
| `rules/messaging.md` | Telegram reply formatting rules |

**`scripts/`** — Operational bash (~300 lines total):

```ts
// scripts/setup.sh (~30 lines)
// Creates agent directory from templates, substitutes agent name in .mcp.json
setup(agentName: string, hindsightPort?: number): void

// scripts/uninstall.sh (~10 lines)
// Removes agent directory + optionally its Hindsight container/volume
uninstall(agentName: string, removeData?: boolean): void

// scripts/auto-retain.sh (~50 lines)
// Stop hook: reads session transcript, spawns Haiku to extract facts,
// POSTs to Hindsight REST API to retain each fact
autoRetain(agentDir: string, bankId: string, hindsightPort: number): void

// scripts/check-memory-size.sh (~15 lines)
// PreToolUse hook: enforces MEMORY.md 50-line cap, rejects Write/Edit if exceeded
checkMemorySize(filePath: string, maxLines: number): exitCode

// scripts/health-check.sh (~20 lines)
// System cron: verifies Hindsight container + ClaudeClaw PID alive, restarts if dead
healthCheck(agentName: string, hindsightPort: number): void

// scripts/export-agent.sh (~40 lines)
// Bundles agent folder + Hindsight DB dump into tarball
exportAgent(agentName: string, outputPath: string): void

// scripts/import-agent.sh (~30 lines)
// Restores agent from tarball + Hindsight DB restore
importAgent(tarballPath: string): void
```

### Files to delete (final patch)

- **All of `src/`** — 154 TypeScript files across 12 subsystems
- **All of `test/`** — Test helpers, fixtures, reporters
- **`dist/`** — Compiled output
- **`tsdown.config.ts`** — Build config
- **`vitest.config.ts`** — Test config
- **`package.json`** — All runtime dependencies (keep only as project metadata if desired)
- **`pnpm-lock.yaml`**, **`node_modules/`**

### Files to keep

- `docs/` — Architecture docs
- `openclaw-source/` — Upstream reference
- `.claude/` — Repo-level Claude Code config (for working on this repo itself)
- `scripts/` — New operational scripts
- `templates/` — New agent templates

## Acceptance Criteria

- [ ] `scripts/setup.sh nova` creates a fully functional agent directory at `~/.openclaude/agents/nova/`
- [ ] `cd ~/.openclaude/agents/nova && claude` loads identity (IDENTITY.md, SOUL.md, etc.) via `@import`
- [ ] Hindsight Docker container starts and responds at configured port (`curl localhost:8888/docs`)
- [ ] Hindsight MCP tools (`retain`, `recall`, `reflect`) work from within a Claude Code session in the agent directory
- [ ] Retain → recall round-trip returns stored memories with entity resolution
- [ ] `/bootstrap` skill triggers and runs an onboarding conversation
- [ ] `/standup` skill generates a git summary
- [ ] `cron-worker` subagent has restricted tool access (Read, Glob, Grep, Bash, Write to `workspace/memory/` only)
- [ ] `log-session.sh` (SessionEnd hook) appends session metadata to manifest; `nightly-memory.sh` batch-processes transcripts and retains facts to Hindsight
- [ ] `check-memory-size.sh` (PreToolUse hook) rejects edits that would push MEMORY.md past 50 lines
- [ ] `health-check.sh` detects down Hindsight container and restarts it
- [ ] `export-agent.sh` produces a restorable tarball; `import-agent.sh` restores from it
- [ ] Telegram works via official plugin (`--channels`) or ClaudeClaw daemon, both from agent directory
- [ ] Two agents (nova + atlas) can run concurrently with separate Hindsight containers and Telegram bots
- [ ] Nightly cron generates `workspace/memory/YYYY-MM-DD.md` from Hindsight temporal recall
- [ ] All `src/` code is deleted — no custom runtime remains
- [ ] No runtime Node.js dependencies — `package.json` has zero `dependencies`

## Open Questions

1. **Ollama vs API key for Hindsight?** Hindsight needs an LLM for entity resolution and reflection. Ollama = fully local but requires install + running service. API key (OpenAI/Anthropic) = simpler but costs money. Which is the default for `setup.sh`?

2. **ClaudeClaw installation method?** The architecture assumes `claude plugin marketplace add moazbuilds/claudeclaw`. Is the plugin marketplace stable enough? Should we document manual installation as fallback?

3. **What happens to `openclaw-source/`?** Keep as reference indefinitely, or remove once migration is complete?

4. **Should `scripts/setup.sh` also start the Hindsight container?** Or keep Docker lifecycle separate (user manages containers explicitly)?

5. **MEMORY.md 50-line cap** — Is 50 the right number? Too few risks losing important context; too many bloats every session.

6. **Should we keep any v1 tests as regression tests for the scripts?** Or start fresh with script-level tests (bats/shellcheck)?

## Explicit Opinions

1. **One Hindsight container per agent, not shared.** Hard isolation prevents memory cross-contamination between agents. The ~200MB RAM cost per container is acceptable for 2-3 agents on a laptop. Shared containers with bank-level isolation are theoretically possible but add failure modes.

2. **ClaudeClaw for daemon/Telegram, not a custom daemon.** ClaudeClaw is ~550 lines, uses the same `claude -p` CLI pattern we'd write ourselves, and already handles session management, model fallback, and auto-compaction. Writing our own daemon would recreate v1's maintenance burden.

3. **Workspace files (`IDENTITY.md`, `SOUL.md`, etc.) are separate from `.claude/` config.** This mirrors OpenClaw's proven pattern and keeps identity editable without touching Claude Code internals. The `CLAUDE.md` bridge file uses `@import` to load them.

4. **Auto-retain via Stop hook is a safety net, not the primary retention mechanism.** The agent should call `retain` during conversations (prompted by AGENTS.md policy). The hook catches what the agent misses. Hindsight's entity resolution handles duplicates.

5. **Delete all of `src/` in one patch, not incrementally.** Incremental deletion risks leaving broken import chains. A clean cut is safer — v2 has zero dependencies on v1 code.

6. **No TypeScript in v2. All scripts are bash.** The entire point is eliminating the build/test/dependency chain. Bash scripts are directly executable, have no dependencies, and are trivially auditable.

## Patches

### Patch 1 [INFRA]: Workspace identity templates

Create `templates/workspace/` with all 7 identity files adapted from OpenClaw patterns.

**Files to create:**
- `templates/workspace/IDENTITY.md` — Agent name/creature/vibe placeholder with instructions for customization
- `templates/workspace/SOUL.md` — Persona, tone, values (adapted from `openclaw-source/` equivalent)
- `templates/workspace/AGENTS.md` — Operating rules including Hindsight memory policy, red lines, group chat etiquette
- `templates/workspace/USER.md` — Placeholder for human's preferences
- `templates/workspace/TOOLS.md` — Placeholder for local environment
- `templates/workspace/HEARTBEAT.md` — Default periodic checklist
- `templates/workspace/MEMORY.md` — Empty file with header comment explaining purpose

**Key content in `AGENTS.md`:**
```markdown
## Memory Policy
When you learn something worth remembering — decisions, preferences, facts,
outcomes — immediately use Hindsight `retain` to store it. Do not rely on
session memory. Sessions are ephemeral. Hindsight is permanent.
```

**Source:** Copy from `openclaw-source/` workspace patterns, adapt naming from OpenClaw → OpenClaude.

---

### Patch 2 [INFRA]: Claude Code config templates

Create `templates/claude/` with CLAUDE.md bridge, MCP config, settings, skills, agents, and rules.

**Files to create:**

`templates/claude/CLAUDE.md`:
```markdown
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

`templates/claude/.mcp.json`:
```json
{
  "mcpServers": {
    "hindsight": {
      "type": "http",
      "url": "http://localhost:__HINDSIGHT_PORT__/mcp/__AGENT_NAME__/"
    }
  }
}
```

`templates/claude/settings.json` — Permissions for `--dangerously-skip-permissions` equivalent + hook definitions pointing to `../../scripts/auto-retain.sh` and `../../scripts/check-memory-size.sh`.

**Skills to create:**
- `templates/claude/skills/bootstrap/SKILL.md` — Triggers: `/bootstrap`. Prompt: onboarding conversation (ask for name, learn about user, populate IDENTITY.md and USER.md)
- `templates/claude/skills/standup/SKILL.md` — Triggers: `/standup`. Prompt: summarize recent git commits across projects
- `templates/claude/skills/research/SKILL.md` — Triggers: `/research`. Prompt: deep research combining web search + Hindsight recall
- `templates/claude/skills/remind/SKILL.md` — Triggers: `/remind`. Prompt: set reminders and manage personal tasks

**Agents to create:**
- `templates/claude/agents/cron-worker.md` — Tools: Read, Glob, Grep, Bash, Write (scoped instruction: only write to `workspace/memory/`)
- `templates/claude/agents/researcher.md` — Tools: Read, WebSearch, WebFetch
- `templates/claude/agents/coder.md` — Tools: all (full access for project work)

**Rules to create:**
- `templates/claude/rules/safety.md` — Never exfiltrate data, ask before destructive operations, alert if workspace files missing from context
- `templates/claude/rules/messaging.md` — Telegram formatting: concise, no markdown headers, use emoji sparingly

---

### Patch 3 [INFRA]: Setup and uninstall scripts

Create `scripts/setup.sh` and `scripts/uninstall.sh`.

**Files to create:**

`scripts/setup.sh` (~30 lines):
- Takes `AGENT_NAME` as first arg (default: `nova`), optional `HINDSIGHT_PORT` (default: `8888`)
- Validates agent doesn't already exist
- Creates `~/.openclaude/agents/$AGENT_NAME/{.claude,workspace/memory}`
- Copies `templates/claude/*` → `.claude/` and `templates/workspace/*` → `workspace/`
- Substitutes `__AGENT_NAME__` and `__HINDSIGHT_PORT__` in `.mcp.json`
- Prints next-steps instructions

`scripts/uninstall.sh` (~10 lines):
- Takes `AGENT_NAME`, confirms before deleting
- Removes `~/.openclaude/agents/$AGENT_NAME/`
- Optionally stops + removes Hindsight container and `~/.hindsight-$AGENT_NAME/` volume

---

### Patch 4 [INFRA]: Memory governance and auto-retain scripts

Create the hook scripts that enforce memory discipline.

**Files to create:**

`scripts/auto-retain.sh` (~50 lines):
- Triggered by Claude Code `Stop` hook
- Reads the most recent session transcript from `~/.claude/projects/<encoded-cwd>/`
- Spawns `echo "<extraction prompt>" | claude -p --model claude-haiku-4-5-20251001 --output-format json` to extract key facts
- Filters out facts already retained during session (extraction prompt instructs this)
- POSTs each fact to Hindsight REST API: `POST http://localhost:$PORT/v1/default/banks/$BANK/memories` with `{"items": [{"content": "..."}]}`
- Logs results to `workspace/memory/retain.log`

`scripts/check-memory-size.sh` (~15 lines):
- Triggered by Claude Code `PreToolUse` hook on Write/Edit targeting `MEMORY.md`
- Counts lines in target file after proposed edit
- Exits non-zero (blocking the edit) if > 50 lines
- Prints warning message explaining the cap

---

### Patch 5 [INFRA]: Health check, export, and import scripts

Create remaining operational scripts.

**Files to create:**

`scripts/health-check.sh` (~20 lines):
- Takes `AGENT_NAME` and `HINDSIGHT_PORT`
- Checks `curl -sf http://localhost:$PORT/docs` — restarts Docker container if fails
- Checks ClaudeClaw PID file — logs warning if dead
- Designed to run from system crontab: `*/5 * * * * /path/to/health-check.sh nova 8888`

`scripts/export-agent.sh` (~40 lines):
- Takes `AGENT_NAME`, optional `OUTPUT_PATH`
- Dumps Hindsight DB: `docker exec hindsight-$AGENT pg_dump` → `hindsight-dump.sql`
- Tars `~/.openclaude/agents/$AGENT/` + dump into `$AGENT-export-YYYY-MM-DD.tar.gz`
- Prints credentials checklist (Telegram token, API keys — not included in export)

`scripts/import-agent.sh` (~30 lines):
- Takes tarball path
- Extracts to `~/.openclaude/agents/`
- Restores Hindsight DB from dump if container is running
- Prints post-import steps (start Hindsight, configure ClaudeClaw)

---

### Patch 6 [INFRA]: Test stubs for scripts

Create test stubs for all bash scripts using bats (Bash Automated Testing System).

**Files to create:**

`scripts/test/setup.bats`:
```bash
@test "setup.sh creates agent directory structure" {
  # PENDING: Patch 8
  skip
  # run setup.sh test-agent
  # assert directory ~/.openclaude/agents/test-agent exists
  # assert .claude/CLAUDE.md contains @import
  # assert .mcp.json has agent name substituted
}

@test "setup.sh rejects duplicate agent name" {
  # PENDING: Patch 8
  skip
}
```

`scripts/test/check-memory-size.bats`:
```bash
@test "check-memory-size.sh allows edits under 50 lines" {
  # PENDING: Patch 8
  skip
}

@test "check-memory-size.sh blocks edits over 50 lines" {
  # PENDING: Patch 8
  skip
}
```

`scripts/test/auto-retain.bats` — stubs for extraction + API call behavior

`scripts/test/health-check.bats` — stubs for restart behavior

---

### Patch 7 [INFRA]: Documentation

Create setup documentation and update repo README.

**Files to create/modify:**

`docs/setup.md`:
- Prerequisites: Docker, Claude Code CLI, ClaudeClaw plugin, (optional) Ollama
- Step-by-step: start Hindsight → run setup.sh → test interactive session → configure ClaudeClaw → verify Telegram
- Troubleshooting: common errors (port conflicts, Docker not running, MCP connection failures)

**Files to update:**
- `CLAUDE.md` (root) — Update project layout section to reflect new `templates/` + `scripts/` structure, remove `src/` references, update commands section

---

### Patch 8 [BEHAVIOR]: Implement test bodies and validate scripts

Unskip all test stubs and implement test bodies. This patch validates that all scripts work correctly.

**Files to modify:**
- `scripts/test/setup.bats` — Implement: create agent, verify structure, verify substitution, verify duplicate rejection
- `scripts/test/check-memory-size.bats` — Implement: create temp MEMORY.md, test under/over cap
- `scripts/test/auto-retain.bats` — Implement: mock Claude CLI + Hindsight API, verify extraction + POST
- `scripts/test/health-check.bats` — Implement: mock Docker/curl, verify restart logic

**Validation:** All bats tests pass. Each script is exercised.

---

### Patch 9 [BEHAVIOR]: Delete v1 runtime

Remove all custom runtime code, tests, build config, and dependencies.

**Files/directories to delete:**
- `src/` — All 154 TypeScript files
- `test/` — All helpers, fixtures, reporters
- `dist/` — Compiled output
- `tsdown.config.ts`
- `vitest.config.ts`

**Files to modify:**
- `package.json` — Remove all `dependencies`, remove `bin`, remove build/test/lint scripts (or repurpose for bats), remove `devDependencies` except what's needed for script testing
- Remove `pnpm-lock.yaml` (regenerate if keeping any deps)

**Validation:** `ls src/` returns "No such file or directory". `package.json` has zero production dependencies. `scripts/setup.sh nova` still works. Bats tests still pass.

---

## Test Map

| Test Name | File | Stub Patch | Impl Patch |
|-----------|------|------------|------------|
| setup.sh > creates agent directory structure | scripts/test/setup.bats | 6 | 8 |
| setup.sh > rejects duplicate agent name | scripts/test/setup.bats | 6 | 8 |
| setup.sh > substitutes agent name in .mcp.json | scripts/test/setup.bats | 6 | 8 |
| check-memory-size.sh > allows edits under 50 lines | scripts/test/check-memory-size.bats | 6 | 8 |
| check-memory-size.sh > blocks edits over 50 lines | scripts/test/check-memory-size.bats | 6 | 8 |
| auto-retain.sh > extracts facts from transcript | scripts/test/auto-retain.bats | 6 | 8 |
| auto-retain.sh > posts to Hindsight API | scripts/test/auto-retain.bats | 6 | 8 |
| health-check.sh > restarts dead Hindsight container | scripts/test/health-check.bats | 6 | 8 |
| health-check.sh > no-ops when services healthy | scripts/test/health-check.bats | 6 | 8 |

## Dependency Graph

```
- Patch 1 [INFRA] -> []
- Patch 2 [INFRA] -> []
- Patch 3 [INFRA] -> [1, 2]
- Patch 4 [INFRA] -> []
- Patch 5 [INFRA] -> []
- Patch 6 [INFRA] -> [3, 4, 5]
- Patch 7 [INFRA] -> [1, 2, 3]
- Patch 8 [BEHAVIOR] -> [6]
- Patch 9 [BEHAVIOR] -> [8]
```

**Parallelization:** Patches 1, 2, 4, 5 can all be developed concurrently (zero dependencies). Patch 3 requires 1+2. Patches 6 and 7 can run concurrently once their deps are met. Patch 8 must follow 6. Patch 9 is always last.

**Mergability insight:** 7 of 9 patches are `[INFRA]` and can ship without changing observable behavior. Only patches 8 (test validation) and 9 (v1 deletion) change behavior.

## Mergability Checklist

- [x] Feature flag strategy documented (not needed — clean cutover, no gradual rollout)
- [x] Early patches contain only non-functional changes (`[INFRA]`)
- [x] Test stubs with `.skip` markers are in early `[INFRA]` patch (Patch 6)
- [x] Test implementations are co-located with the code they test (Patch 8)
- [x] Test Map is complete: every test has Stub Patch and Impl Patch assigned
- [x] Test Map Impl Patch matches the patch that implements the tested code
- [x] `[BEHAVIOR]` patches are as small as possible (2 of 9)
- [x] Dependency graph shows `[INFRA]` patches early, `[BEHAVIOR]` patches late
- [x] Each `[BEHAVIOR]` patch is clearly justified (8 = validates scripts work, 9 = deletes v1)
