# OpenClaude

An autonomous AI assistant powered by Claude Code CLI. Fork of OpenClaw's architecture with Claude Code as the sole engine.

**IMPORTANT: OpenClaude and OpenClaw are separate projects. Do not confuse them.** OpenClaw is the upstream project we forked from — it uses a different agent runtime (Pi). OpenClaude is THIS project — it replaces OpenClaw's engine with Claude Code CLI. When writing code, configs, docs, logs, or identifiers, always use "openclaude" (not "openclaw"). References to OpenClaw should only appear when discussing the upstream origin of extracted code.

**Copy from OpenClaw first.** The OpenClaw source lives at `openclaw-source/` (inside this repo). When implementing a module that exists in OpenClaw, copy the code directly and adapt it rather than writing from scratch. This saves complexity and keeps behavior consistent with the proven upstream implementation. Only diverge where Claude Code's engine requires it (e.g., `engine/`, `spawn`).

## Project Structure

```
src/
  config/             # Config loader (JSON + Zod validation + env var substitution)
  engine/             # Claude Code CLI subprocess management (spawn, pool)
  gateway/            # Node.js daemon (Hono HTTP + launchd + lifecycle)
  channels/           # Channel abstraction layer
  channels/telegram/  # grammY integration (long-polling, chunking, allow-list)
  channels/slack/     # Bolt integration (socket mode, threads)
  router/             # Fixed routing table (no LLM dispatch)
  memory/             # SQLite + FTS5 + sqlite-vec memory system
  cron/               # Croner-based scheduling + heartbeat
  skills/             # Skill loader + slash command routing
  tools/              # Agent tools (memory, send, file)
  cli/                # CLI commands (openclaude start/stop/status/etc.)
```

## Runtime Data

All runtime data lives at `~/.openclaude/`:

```
~/.openclaude/
  config.json           # Main configuration
  HEARTBEAT.md          # Heartbeat checklist
  gateway.pid           # Running process PID
  memory/
    openclaude.sqlite   # Memory index (SQLite + FTS5 + sqlite-vec)
    *.md                # Memory files (source of truth)
  sessions/<id>/
    prompt.md           # Prompt written before spawning claude
  skills/*.md           # Skill definitions
  cron/jobs.json        # Persisted cron jobs
  logs/
    gateway.log         # stdout
    gateway.err.log     # stderr
```

Source code (`~/Desktop/openclaude/`) reads/writes runtime data. Runtime data never affects source code.

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
- **Prompt via stdin.** Write prompt to stdin pipe, never as CLI arguments or `--input-file` (that flag doesn't exist).
- **`--output-format json` returns an array** of events. Parse with `findLast(e => e.type === "result")` to extract the response text.
- **No `--dangerously-skip-permissions`.** That flag forces API auth mode. Pro subscription works without it — `-p` handles non-interactive mode.
- **Session isolation:** Each subagent gets a unique `--project` path under `~/.openclaude/sessions/<id>/`. Never use `--continue`.
- **Process pool:** Max 4 concurrent Claude Code processes. FIFO queue for excess requests.
- **Fixed routing:** Static dispatch table, not LLM-based orchestrator. Commands handled directly, user messages go to main session, cron jobs spawn isolated sessions.
- **Unset CLAUDECODE env var** before spawning subprocesses to avoid "nested session" error.
- **Memory is extracted from OpenClaw.** Two-layer: markdown files as source of truth, SQLite FTS5 + sqlite-vec as index. 6 embedding providers with auto-selection. Hybrid search (vector 0.7 + keyword 0.3).
- **Skills are extracted from OpenClaw.** SKILL.md format with YAML frontmatter, auto-discovery, slash command routing.

## Known Issues / Gotchas

- **Empty `allowFrom` array blocks everyone.** Omit the field entirely to allow all users. Only set it when you have specific user IDs.
- **Env var substitution runs on ALL config values**, even disabled channels. Don't use `$VAR` syntax for channels you haven't configured — either omit the channel block or use literal values.
- **Zod validates disabled channel tokens.** If a channel block exists, its required fields must be valid even if `enabled: false`. Best practice: omit the entire channel block if not using it.
- **Telegram 409 Conflict:** Only one process can poll a bot token. Kill old instances (check `launchctl list | grep openclaude`, `lsof -i :45557`) before starting.

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
- Co-located tests (`foo.test.ts` next to `foo.ts`)

## Claude Code CLI Reference

```bash
# Correct usage (what we do):
echo "prompt" | claude -p --output-format json

# Flags that work with Pro subscription:
claude -p                    # print mode (non-interactive)
--output-format json         # returns JSON array of events
--output-format stream-json  # streaming events (future use)
--system-prompt "text"       # system prompt as string literal
--mcp-config path.json       # MCP server config file
--model claude-sonnet-4-6    # model override

# Flags that DO NOT work / don't exist:
--input-file                 # DOES NOT EXIST — use stdin
--dangerously-skip-permissions  # forces API auth, breaks Pro subscription
```

## Design Doc

Full architecture and design decisions: `docs/plans/2026-03-12-openclaude-design.md`
