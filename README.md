# OpenClaude

An open-source autonomous AI assistant powered by Claude Code CLI. Runs on your Claude Pro/Max subscription — no API keys needed.

OpenClaude connects to Telegram and Slack, remembers everything, runs scheduled tasks, and messages you proactively. It's not a chatbot wrapper — it's an autonomous agent that uses Claude Code as its brain.

## Features

**Messaging**
- Telegram (grammY) and Slack (Bolt) — two-way, autonomous communication
- The agent receives messages AND sends proactively
- Allow-list access control per channel
- Long message chunking, media support, thread replies (Slack)

**Agent Engine**
- Spawns `claude -p` subprocesses per task — full Claude Code capabilities
- Session isolation with unique `--project` paths
- Process pool with configurable concurrency (default 4) and FIFO queue
- Wall-clock timeouts with process group cleanup

**Memory**
- Persistent memory stored as markdown files (human-readable, editable)
- SQLite + FTS5 + sqlite-vec index for fast search
- Hybrid search: 70% vector similarity + 30% keyword matching
- 6 embedding providers (local, OpenAI, Gemini, Voyage, Mistral, Ollama)
- Temporal decay — recent memories rank higher (30-day half-life)
- MMR re-ranking for result diversity
- Auto-flush — saves important info before session ends

**Cron & Heartbeats**
- Scheduled tasks with cron expressions
- Two modes: inject into main session or spawn isolated session
- Heartbeat checklist (`HEARTBEAT.md`) — agent reviews it periodically and acts
- Proactive messaging — results delivered to any configured channel

**Skills**
- Markdown playbooks (`SKILL.md` format with YAML frontmatter)
- Auto-discovery from `~/.openclaude/skills/`
- Slash command routing — `/skillname` triggers the skill
- Bring your own workflows

**Subagent Management**
- `/list` — see running agents
- `/stop <id>` — kill a specific agent
- `/status` — pool stats
- `/help` — command reference

**Integrations**
- Any MCP server (GitHub, Google Workspace, Supabase, filesystem, etc.)
- Configured in `config.json`, passed through to Claude Code

## Requirements

- Node.js >= 22
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- Claude Pro or Max subscription
- pnpm

## Quick Start

```bash
# Clone and install
git clone https://github.com/yourusername/openclaude.git
cd openclaude
pnpm install
pnpm build

# Create config
mkdir -p ~/.openclaude
cat > ~/.openclaude/config.json << 'EOF'
{
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_BOT_TOKEN",
      "allowFrom": ["YOUR_USER_ID"]
    }
  }
}
EOF

# Set your bot token and start
export TELEGRAM_BOT_TOKEN="your-token-here"
openclaude start
```

## Configuration

Config lives at `~/.openclaude/config.json`. Environment variables are expanded (`$VAR`, `${VAR}`, `${VAR:-default}`).

```jsonc
{
  // Messaging channels
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "$TELEGRAM_BOT_TOKEN",
      "allowFrom": ["123456789"],       // Telegram user IDs (optional)
      "mode": "polling"                  // "polling" or "webhook"
    },
    "slack": {
      "enabled": true,
      "botToken": "$SLACK_BOT_TOKEN",
      "appToken": "$SLACK_APP_TOKEN",
      "mode": "socket",                 // "socket" or "http"
      "allowFrom": ["U1234567"]         // Slack user IDs (optional)
    }
  },

  // Agent engine
  "agent": {
    "maxConcurrent": 4,                 // Max parallel Claude processes
    "defaultTimeout": 300000,           // 5 min timeout per task
    "model": "claude-sonnet-4-6"        // Optional model override
  },

  // Heartbeat
  "heartbeat": {
    "enabled": true,
    "every": 1800000,                   // 30 minutes
    "target": {
      "channel": "telegram",
      "chatId": "123456789"
    }
  },

  // Cron
  "cron": {
    "enabled": true
  },

  // Memory
  "memory": {
    "dbPath": "~/.openclaude/memory/openclaude.sqlite"
  },

  // MCP servers (passed through to Claude Code)
  "mcp": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "$GITHUB_TOKEN" }
    }
  }
}
```

## CLI

```bash
openclaude start          # Start the daemon
openclaude stop           # Stop the daemon
openclaude status         # Show running status and pool stats
openclaude setup          # Interactive config generator
openclaude skills list    # List loaded skills
openclaude memory search  # Search memory from CLI
openclaude logs           # Tail gateway logs
```

## Chat Commands

Send these to your bot in Telegram or Slack:

| Command | Description |
|---------|-------------|
| `/help` | Show available commands |
| `/list` | List running agent sessions |
| `/stop <id>` | Kill a running session |
| `/status` | Pool stats (running, queued, max) |
| `/skills` | List available skills |
| `/cron list` | List scheduled jobs |
| `/cron add` | Add a cron job |
| `/cron remove` | Remove a cron job |

Any non-command message is routed to Claude Code for an autonomous response.

## Skills

Drop a `SKILL.md` file in `~/.openclaude/skills/` to add a skill:

```markdown
---
name: daily-standup
description: Generate a daily standup summary
triggers:
  - /standup
---

Review my recent git commits, calendar events, and open PRs.
Summarize what I did yesterday, what I'm doing today, and any blockers.
Keep it concise — 3 bullets max per section.
```

Trigger it by sending `/standup` to your bot.

## Heartbeat

Create `~/.openclaude/HEARTBEAT.md` with a checklist:

```markdown
# Heartbeat Checklist

- [ ] Check if any GitHub PRs need review
- [ ] Check if any scheduled deploys are coming up
- [ ] Summarize unread Slack messages in #engineering
```

The agent reviews this periodically and messages you if there's anything worth reporting.

## Directory Structure

```
~/.openclaude/
  config.json              # Main configuration
  HEARTBEAT.md             # Heartbeat checklist
  memory/
    openclaude.sqlite      # Memory index (SQLite + FTS5 + sqlite-vec)
    *.md                   # Memory files (human-readable)
  skills/
    *.md                   # Skill definitions
  sessions/
    <id>/                  # Isolated session workspaces
  cron/
    jobs.json              # Persisted cron jobs
  logs/
    gateway.log            # Gateway logs
```

## Architecture

```
Telegram/Slack message
        │
        ▼
   Gateway daemon (Node.js + Hono)
        │
        ▼
   Fixed router ──── /commands → direct response
        │
        ▼
   Process pool (max 4)
        │
        ▼
   claude -p --input-file prompt.md --project ~/.openclaude/sessions/<id>/
        │
        ▼
   Response → channel → user
```

Key design decisions:
- **CLI, not SDK** — runs on your subscription, no API keys
- **Fixed routing** — static dispatch, no LLM deciding how to route
- **Session isolation** — each task gets its own `--project` path
- **Process pool** — bounded concurrency with FIFO queue
- **Prompt via file** — never passes user content as CLI arguments

## Development

```bash
pnpm install       # Install dependencies
pnpm build         # Build with tsdown
pnpm dev           # Watch mode
pnpm test          # Run tests (vitest)
pnpm lint          # Lint (oxlint)
pnpm format        # Format (oxfmt)
```

48 source files, 35 test files, 384 tests.

## Credits

Memory system, skills framework, and channel adapters extracted from [OpenClaw](https://github.com/openclaw/openclaw).

## License

MIT
