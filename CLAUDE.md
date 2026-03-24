# OpenClaude v2

General-purpose personal AI assistant built on Claude Code native features + ClaudeClaw (daemon/Telegram) + Hindsight (semantic memory). Zero custom runtime code.

## Architecture

- **Agent directories** (`~/.openclaude/agents/<name>/`) — self-contained, each with `.claude/` config + `workspace/` identity files
- **Hindsight** — Docker container per agent, MCP-first semantic memory (retain/recall/reflect)
- **Telegram** — Official Anthropic plugin (interactive) or ClaudeClaw (daemon mode, cron, heartbeat)
- **Native Claude Code** — Skills, agents, hooks, rules, sessions, CLAUDE.md `@import`

## Project Layout

```
templates/
  workspace/     # Agent identity templates (IDENTITY.md, SOUL.md, AGENTS.md, etc.)
  claude/        # Claude Code config templates (CLAUDE.md bridge, .mcp.json, skills, agents, rules, claudeclaw)

scripts/
  setup.sh           # Create new agent from templates
  uninstall.sh       # Remove agent
  spawn-worker.sh      # Spawn parallel claude -p workers from agent dir
  log-session.sh       # SessionEnd hook: append session to manifest
  nightly-memory.sh    # Nightly cron: process transcripts + generate daily log
  check-memory-size.sh  # PreToolUse hook: enforce MEMORY.md 50-line cap
  health-check.sh    # System cron: verify Hindsight + ClaudeClaw alive
  export-agent.sh    # Bundle agent + Hindsight data for migration
  import-agent.sh    # Restore agent on new machine
  test/              # Bats test files

docs/
  plans/             # Architecture docs and gameplans
  setup.md           # Setup guide
```

## Installed Agent Layout

```
~/.openclaude/agents/nova/
  .claude/
    CLAUDE.md          # Bridge: @imports workspace files
    .mcp.json          # Hindsight MCP server
    settings.json      # Permissions + hooks
    skills/            # bootstrap, standup, research, remind
    agents/            # cron-worker, researcher, coder
    rules/             # safety, messaging
  workspace/
    IDENTITY.md        # Agent name, creature, vibe, emoji
    SOUL.md            # Persona, tone, values
    AGENTS.md          # Operating rules, memory policy
    USER.md            # Human's preferences
    TOOLS.md           # Local environment
    HEARTBEAT.md       # Periodic checklist
    MEMORY.md          # Curated cheat sheet (always in context)
    memory/            # Daily logs (nightly cron from Hindsight)
```

## Conventions

- **All scripts are bash.** No TypeScript, no build step, no runtime dependencies.
- **Commit after every change.** Each logical change gets its own commit.
- **Copy from OpenClaw patterns.** Check if OpenClaw's workspace patterns apply before inventing new ones.
- **Test scripts with bats** (Bash Automated Testing System).

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

# USE WITH CAUTION:
--dangerously-skip-permissions  # bypasses all permission prompts (needed for daemon mode)
```

- **Output is a JSON array** of events. Extract response: `parsed.findLast(e => e.type === "result").result`
- **Unset env vars** before spawning: `CLAUDECODE`, `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `CLAUDE_CODE_ENTRYPOINT`

## Gameplan

`docs/plans/2026-03-23-openclaude-v2-architecture.md`
