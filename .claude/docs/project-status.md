# OpenClaude Project Status

Last updated: 2026-03-13 00:20 AM

## Project Overview

OpenClaude is an open-source autonomous AI assistant that replaces OpenClaw, powered by Claude Code CLI (Pro/Max subscription, no API keys). Lives at `~/Desktop/openclaude/` with runtime data at `~/.openclaude/`.

## Phase Status

| Phase | Status | Details |
|-------|--------|---------|
| Phase 1 | **COMPLETE** | Config, engine, gateway, Telegram, router, CLI |
| Phase 2 | **COMPLETE** | Memory system, cron, heartbeat, proactive messaging |
| Phase 3 | **COMPLETE** | Slack, skills, tools (memory/send/file), MCP passthrough |
| Phase 4 | **NOT STARTED** | README, Docker, CI, npm publish, open source launch |
| TDD suite | **COMPLETE** | 388 tests across 35 files, all passing |

## What Works (Tested)

- Build: clean, 28 output files
- Tests: 388/388 passing
- Health endpoint: `curl http://localhost:45557/health` returns ok
- Telegram bot connects and receives messages
- Claude Code roundtrip: user message → spawn `claude -p` → response back to Telegram
- `/help`, `/status`, `/list`, `/stop` commands — all work via Telegram
- `/memory`, `/memorysync` commands — registered in router
- Memory CLI search (`node dist/cli/index.js memory search "query"`) — works, finds results
- Skills CLI discovery (`node dist/cli/index.js skills list`) — works, finds daily-standup skill
- `openclaude status` — shows PID, uptime, channels, pool stats
- Gateway start/restart lifecycle

## What's Fixed (Bugs Found During Testing)

1. **Env var substitution crash** — `$SLACK_BOT_TOKEN` in config crashes even when Slack disabled. Fix: omit unused channel blocks from config.
2. **Zod validates disabled channels** — empty string fails `min(1)`. Fix: omit channel block entirely.
3. **Empty `allowFrom: []` blocks everyone** — empty set = deny all. Fix: omit field to allow all users.
4. **`--dangerously-skip-permissions` forces API auth** — removed from spawn args.
5. **`--input-file` flag doesn't exist** — switched to stdin pipe (`proc.stdin.write(prompt)`).
6. **JSON output parser wrong format** — Claude returns array, not object. Fixed to use `findLast(e => e.type === "result")`.
7. **ANTHROPIC_API_KEY empty string causes 401** — deleted from subprocess env along with CLAUDE_API_KEY and CLAUDE_CODE_ENTRYPOINT.
8. **Skill YAML parser** — didn't handle `- item` list syntax. Fixed.
9. **Skill trigger slash mismatch** — trigger `/standup` vs matched `standup`. Fixed with normalization.
10. **Skills not wired into router** — skill triggers now intercept before falling through to Claude.

## Known Remaining Bugs

### Bug: 401 errors still intermittent
- **Cause:** Gateway was running old build when tested. After rebuild + restart, the env var fix should resolve this. Needs re-test.
- **Location:** src/engine/spawn.ts (env var deletion)

### Bug: Memory tools not in Claude's system prompt
- **Cause:** When user asks "what do you know about Sean?", Claude doesn't search memory because it doesn't know it can. Memory CLI works but the agent doesn't have tool descriptions.
- **Fix needed:** Use `--append-system-prompt` to inject memory context into Claude subprocess. Pre-fetch relevant memories via memoryManager.search() and include in prompt context.
- **Location:** src/router/router.ts (where user messages are submitted to pool)

### Bug: `openclaude stop` CLI doesn't kill background processes
- **Cause:** Sends SIGTERM via PID file but doesn't work when gateway was started with `&` in terminal. Works correctly when running as launchd agent.
- **Severity:** Minor — normal usage is via launchd.

## Config File

`~/.openclaude/config.json` — currently configured for Telegram only:
```json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "<redacted>"
    }
  },
  "agent": { "maxConcurrent": 4, "defaultTimeout": 300000 },
  "heartbeat": { "enabled": false, "every": 1800000 },
  "cron": { "enabled": false },
  "mcp": {},
  "memory": {}
}
```

Note: Slack block must be omitted entirely (not just disabled) to avoid env var / Zod validation issues.

## Runtime Files Created

- `~/.openclaude/config.json` — main config
- `~/.openclaude/HEARTBEAT.md` — heartbeat checklist
- `~/.openclaude/memory/test-fact.md` — test memory file ("Sean loves building autonomous agents with TypeScript")
- `~/.openclaude/memory/openclaude.sqlite` — SQLite memory DB (auto-created)
- `~/.openclaude/skills/daily-standup/SKILL.md` — test skill
- `~/.openclaude/sessions/main-*/prompt.md` — session prompts from test messages

## Codebase Stats

- 48 source files, 35 test files
- Source: src/{channels,cli,config,cron,engine,gateway,memory,router,skills,tools}
- Docs: docs/plans/ (4 design docs)
- CLAUDE.md and README.md updated to reflect actual behavior (stdin, no --input-file, etc.)

## What Hasn't Been Tested

- Cron jobs (not enabled in config)
- Heartbeat (not enabled in config, needs chat ID)
- Slack channel (not configured)
- MCP passthrough (no MCP servers configured)
- Skills via Telegram (`/standup`) — fix just landed, needs rebuild + restart + manual test
- Memory via Telegram — fix not yet implemented (system prompt injection)
- Long message chunking (>4096 chars)
- Photo/document handling
- Multiple concurrent Claude sessions (pool queueing)

## Telegram Bot

- Username: @anythingbutabot
- Token: in config (should be revoked before open source — was shared in plain text)

## Next Steps

1. Fix memory system prompt injection (Bug above)
2. Rebuild + restart gateway
3. Re-test: `/standup`, "what do you know about Sean?", "what's 2+2" (no 401)
4. Enable and test cron + heartbeat
5. Phase 4: README, Docker, CI, open source launch

## Prompt for Next Agent (Bug Fixes)

A comprehensive prompt was generated covering all 4 remaining bugs. User has it ready to paste into a new Claude Code session. It covers:
1. 401 env var verification
2. Memory system prompt injection via --append-system-prompt
3. Skill wiring (already fixed by background agent)
4. Skills passed to router at boot (already fixed by background agent)
