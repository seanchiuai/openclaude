# OpenClaude

An autonomous AI assistant powered by Claude Code CLI. Fork of OpenClaw's architecture with Claude Code as the sole engine.

**IMPORTANT: OpenClaude and OpenClaw are separate projects. Do not confuse them.** OpenClaw is the upstream project we forked from — it uses a different agent runtime (Pi). OpenClaude is THIS project — it replaces OpenClaw's engine with Claude Code CLI. When writing code, configs, docs, logs, or identifiers, always use "openclaude" (not "openclaw"). References to OpenClaw should only appear when discussing the upstream origin of extracted code.

## Project Structure

```
src/
  gateway/          # Node.js daemon (Hono HTTP + process lifecycle)
  channels/         # Channel abstraction layer
  channels/telegram/  # grammY integration
  channels/slack/     # Bolt integration
  engine/           # Claude Code CLI subprocess management
  memory/           # SQLite + FTS5 + sqlite-vec memory system
  cron/             # Croner-based scheduling + heartbeat
  router/           # Fixed routing table (no LLM dispatch)
  skills/           # Skill loader, commands, installer
  tools/            # Agent tools (web, image, pdf, sessions, etc.)
  config/           # Config loader (YAML/JSON)
  cli/              # CLI commands (openclaude start/status/etc.)
```

## Tech Stack

- **Runtime:** Node.js >= 22, TypeScript (ESM), pnpm
- **Telegram:** grammY v1.41
- **Slack:** @slack/bolt v4.6
- **Cron:** Croner v10
- **Database:** better-sqlite3 + sqlite-vec
- **HTTP:** Hono v4
- **Build:** tsdown
- **Lint:** oxlint + oxfmt
- **Test:** vitest
- **Validation:** Zod v4

## Key Architecture Decisions

- **Claude Code CLI is the agent engine.** We spawn `claude -p` subprocesses per agent turn. No SDK, no API keys — uses Pro/Max subscription.
- **Session isolation:** Each subagent gets a unique `--project` path under `~/.openclaude/sessions/<id>/`. Never use `--continue`.
- **Process pool:** Max 4 concurrent Claude Code processes. Queue excess requests.
- **Prompt via file:** Never pass user message content as CLI arguments. Write to a temp file, pass `--input-file`.
- **Fixed routing:** Static dispatch table, not LLM-based orchestrator. Commands handled directly, user messages go to main session, cron jobs spawn isolated sessions.
- **Memory is extracted from OpenClaw.** Two-layer: markdown files as source of truth, SQLite FTS5 + sqlite-vec as index. 6 embedding providers with auto-selection. Hybrid search (vector 0.7 + keyword 0.3).
- **Skills are extracted from OpenClaw.** SKILL.md format with YAML frontmatter, auto-discovery, slash command routing.
- **Sandbox mode:** All Claude Code subprocesses run with `--dangerously-skip-permissions`.

## Common Commands

```bash
pnpm install          # install deps
pnpm build            # build with tsdown
pnpm dev              # dev mode with watch
pnpm test             # run vitest
pnpm lint             # oxlint
pnpm format           # oxfmt
```

## Code Conventions

- ESM only (`"type": "module"` in package.json)
- File extensions in imports (`.js` suffix for TypeScript ESM)
- Zod for all config/input validation
- No classes unless necessary — prefer functions and plain objects
- No `any` types — use `unknown` and narrow
- Error handling: let errors propagate, catch at boundaries only
- No console.log — use structured logger

## Source Code Origin

Most modules are extracted from [OpenClaw](https://github.com/openclaw/openclaw). When extracting:
- Strip OpenClaw-specific imports, replace with local paths
- Remove references to Pi agent runtime
- Keep the core logic intact — don't rewrite working code
- Preserve test files alongside source files

## Config Location

- Config: `~/.openclaude/config.json`
- Memory DB: `~/.openclaude/memory/openclaude.sqlite`
- Skills: `~/.openclaude/skills/`
- Sessions: `~/.openclaude/sessions/<id>/`
- Cron: `~/.openclaude/cron/jobs.json`
- Logs: `~/.openclaude/logs/`
- Heartbeat: `~/.openclaude/HEARTBEAT.md`

## Design Doc

Full architecture and design decisions: `docs/plans/2026-03-12-openclaude-design.md`
