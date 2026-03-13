# OpenClaude

Autonomous AI assistant powered by Claude Code CLI. Forked from OpenClaw (different agent runtime). Always use "openclaude" in code/configs — only reference OpenClaw when discussing upstream origin.

**Copy from OpenClaw first.** Source at `openclaw-source/`. Copy and adapt rather than rewrite. Only diverge where Claude Code's engine requires it.

## Commands

```bash
pnpm install    pnpm build    pnpm dev
pnpm test       pnpm lint     pnpm format
```

## Code Conventions

- ESM only, `.js` suffix in imports, Zod for validation
- Functions over classes, `unknown` over `any`, co-located tests (`foo.test.ts`)
- Errors propagate; catch at boundaries only

## Project Layout

```
src/
  config/      engine/      gateway/     channels/    router/
  memory/      cron/        skills/      mcp/         tools/      cli/

~/.openclaude/
  config.json   HEARTBEAT.md   gateway.pid   sessions-map.json
  memory/       sessions/      skills/       cron/jobs.json   logs/
```

## Claude Code CLI — Critical Rules

```bash
# Correct: pipe prompt via stdin
echo "prompt" | claude -p --output-format json

# Valid flags:
-p  --output-format json|stream-json  --system-prompt "text"
--mcp-config path.json  --model claude-sonnet-4-6
--session-id <uuid>  --resume <uuid>

# DO NOT USE — will break:
--input-file                    # doesn't exist
--dangerously-skip-permissions  # forces API auth, breaks Pro subscription
```

- **Output is a JSON array** of events. Extract response: `parsed.findLast(e => e.type === "result").result`
- **Unset env vars** before spawning: `CLAUDECODE`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `CLAUDE_CODE_ENTRYPOINT`
- **Session isolation:** unique `--project` path per session under `~/.openclaude/sessions/<id>/`
- **Process pool:** max 4 concurrent, FIFO queue for excess
- **Session continuity:** `--session-id` on first message, `--resume` on subsequent. Auto-reset after 4h idle. State persisted to `sessions-map.json`.

## Router Dispatch Order

First match wins:

1. **Gateway commands** (`/status`, `/help`, `/skills`, `/memory`, `/cron`) — direct response, no spawn
2. **Skill triggers** (`/standup`, etc.) — skill body as prompt, spawns Claude Code
3. **Cron jobs** (`source === "cron"`) — isolated session each time
4. **User messages** — main session with `--resume`, memory context on first message

## Skills

`SKILL.md` files in `~/.openclaude/skills/` (recursive). YAML frontmatter + markdown body:

```yaml
---
name: daily-standup
description: Generate a daily standup summary
triggers:
  - /standup
  - standup
---
Review my recent git commits and summarize.
```

Trigger matching normalizes leading `/`. Args appended as `\n\nUser request: <args>`.

## MCP Gateway Tools

Auto-injected MCP server gives Claude Code subprocesses access to gateway APIs:

`cron_list` `cron_status` `cron_add` `cron_remove` `cron_run` · `memory_search` `memory_get` · `send_message`

Standalone stdio server (`src/mcp/gateway-tools-server.ts`) proxies to HTTP API (`/api/cron/*`, `/api/memory/*`, `/api/send`).

## Gotchas

- **Empty `allowFrom` array blocks everyone** — omit the field to allow all users
- **Env var substitution runs on ALL config values** — omit unused channel blocks entirely
- **Zod validates disabled channels** — if a channel block exists, required fields must be valid
- **Telegram 409 Conflict** — only one process can poll a bot token; kill old instances first

## Design Doc

`docs/plans/2026-03-12-openclaude-design.md`
