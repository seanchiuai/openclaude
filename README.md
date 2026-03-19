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
# 1. Clone and install
git clone https://github.com/yourusername/openclaude.git
cd openclaude
pnpm install
pnpm build

# 2. Run the onboarding wizard
openclaude onboard
```

The wizard walks you through:
1. Checking that Claude Code CLI is installed and authenticated
2. Connecting channels (Telegram, Slack, both, or neither)
3. Choosing a memory/embedding provider
4. Creating `~/.openclaude/` with all config and directories
5. Optionally starting the gateway

To get a Telegram bot token, talk to [@BotFather](https://t.me/BotFather). To restrict access, add `"allowFrom": ["YOUR_TELEGRAM_USER_ID"]` to your config — get your ID from [@userinfobot](https://t.me/userinfobot).

### Manual setup (alternative)

If you prefer to configure manually:

```bash
openclaude setup        # Creates directories + minimal config
vi ~/.openclaude/config.json  # Add your channel tokens
openclaude start        # Start the gateway
```

## Configuration

Config lives at `~/.openclaude/config.json`. Environment variables are expanded (`$VAR`, `${VAR}`, `${VAR:-default}`).

```jsonc
{
  // Messaging channels — only include channels you're using
  "channels": {
    "telegram": {
      "enabled": true,
      "botToken": "your-bot-token",    // or "$TELEGRAM_BOT_TOKEN"
      "allowFrom": ["123456789"],      // Telegram user IDs (omit to allow all)
      "mode": "polling"                // "polling" or "webhook"
    },
    "slack": {
      "enabled": true,
      "botToken": "$SLACK_BOT_TOKEN",
      "appToken": "$SLACK_APP_TOKEN",
      "mode": "socket",               // "socket" or "http"
      "allowFrom": ["U1234567"]       // Slack user IDs (omit to allow all)
    }
  },

  // Agent engine
  "agent": {
    "maxConcurrent": 4,               // Max parallel Claude processes
    "defaultTimeout": 300000           // 5 min timeout per task
  },

  // Heartbeat
  "heartbeat": {
    "enabled": true,
    "every": 1800000,                 // 30 minutes
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

**Important:** Only include channel blocks you're actually using. Omit the entire `slack` block if you only use Telegram (and vice versa). Env vars like `$SLACK_BOT_TOKEN` will fail if not set, even when the channel is disabled.

## CLI

```bash
openclaude onboard        # Interactive setup wizard (first-time)
openclaude setup          # Non-interactive setup (directories + minimal config)
openclaude start          # Start the daemon
openclaude stop           # Stop the daemon
openclaude status         # Show running status and pool stats
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

## Architecture

```
Telegram/Slack message
        |
        v
   Gateway daemon (Node.js + Hono)
        |
        v
   Fixed router ---- /commands -> direct response
        |
        v
   Process pool (max 4)
        |
        v
   echo "prompt" | claude -p --output-format json
        |
        v
   Parse result event -> channel -> user
```

Key design decisions:
- **CLI, not SDK** — runs on your subscription, no API keys
- **Fixed routing** — static dispatch, no LLM deciding how to route
- **Session isolation** — each task gets its own `--project` path
- **Process pool** — bounded concurrency with FIFO queue
- **Prompt via stdin** — never passes user content as CLI arguments

## Directory Structure

```
~/.openclaude/
  config.json              # Main configuration
  HEARTBEAT.md             # Heartbeat checklist
  gateway.pid              # Running process PID
  memory/
    openclaude.sqlite      # Memory index (SQLite + FTS5 + sqlite-vec)
    *.md                   # Memory files (human-readable)
  skills/
    *.md                   # Skill definitions
  sessions/
    <id>/                  # Isolated session workspaces
      prompt.md            # Prompt sent to Claude
  cron/
    jobs.json              # Persisted cron jobs
  logs/
    gateway.log            # stdout
    gateway.err.log        # stderr
```

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
