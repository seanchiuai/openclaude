# OpenClaude v2 — Setup Guide

## Prerequisites

- **Docker** — for running Hindsight memory containers
- **Claude Code CLI** — `claude` command available in PATH
- **Ollama** — local LLM for Hindsight entity resolution (no API keys needed)
  - Install: `brew install ollama` or https://ollama.ai
  - Start: `ollama serve`
  - Pull a model: `ollama pull llama3.2`
- **ClaudeClaw** (optional) — for daemon mode and Telegram integration
  - `claude plugin marketplace add moazbuilds/claudeclaw`

## Quick Start

### 1. Create an Agent

```bash
# From the openclaude repo directory:
./scripts/setup.sh nova

# With custom Hindsight port:
./scripts/setup.sh atlas 8889
```

This creates `~/.openclaude/agents/nova/` with:
- `.claude/` — Claude Code config (CLAUDE.md bridge, MCP, hooks, skills, agents, rules)
- `workspace/` — Identity files (IDENTITY.md, SOUL.md, AGENTS.md, etc.)
- A running Hindsight Docker container at `localhost:8888`

### 2. Start a Session

```bash
cd ~/.openclaude/agents/nova
claude
```

Claude will load your agent's identity via the CLAUDE.md bridge file.

### 3. Run Bootstrap

In your first session, run `/bootstrap` to:
- Choose your agent's name, creature type, vibe, and emoji
- Set up your human profile (name, timezone, preferences)
- Customize SOUL.md together

### 4. Verify Hindsight

```bash
# Check Hindsight is running:
curl http://localhost:8888/docs

# Test memory from within a Claude session:
# Use `retain` to store a fact, then `recall` to retrieve it
```

### 5. Configure ClaudeClaw (Optional)

For daemon mode + Telegram:

1. Create a Telegram bot via @BotFather
2. Install ClaudeClaw: `claude plugin marketplace add moazbuilds/claudeclaw`
3. Configure with your bot token and agent directory
4. ClaudeClaw spawns `claude -p` with CWD = your agent directory

## Multiple Agents

Each agent gets its own Hindsight container on a different port:

```bash
./scripts/setup.sh nova 8888
./scripts/setup.sh atlas 8889
```

Agents are fully isolated — separate identity, separate memory, separate config.

## Troubleshooting

### Hindsight won't start
- Check Docker is running: `docker info`
- Check port isn't in use: `lsof -i :8888`
- Check container logs: `docker logs hindsight-nova`

### MCP connection fails
- Verify Hindsight is running: `curl http://localhost:8888/docs`
- Check `.claude/.mcp.json` has correct port
- Restart Claude Code session after fixing config

### Agent identity not loading
- Verify CLAUDE.md has `@import` directives: `cat ~/.openclaude/agents/nova/.claude/CLAUDE.md`
- Check workspace files exist: `ls ~/.openclaude/agents/nova/workspace/`

## Agent Management

```bash
# Export agent (for migration):
./scripts/export-agent.sh nova

# Import agent (on new machine):
./scripts/import-agent.sh nova-export-2026-03-23.tar.gz

# Remove agent:
./scripts/uninstall.sh nova

# Remove agent + all data:
./scripts/uninstall.sh nova --remove-data

# Health check (add to crontab):
*/5 * * * * /path/to/scripts/health-check.sh nova 8888
```
