# OpenClaude

Personal AI assistant framework built on Claude Code native features. Create autonomous, persistent agents with long-term memory — zero custom runtime code.

OpenClaude replaces the original 35k-line TypeScript runtime with a thin bash configuration layer. Each agent is a self-contained directory with identity files, Claude Code config, and a dedicated Hindsight memory container.

## How It Works

```
You ──► Claude Code session ──► Agent directory (~/.openclaude/agents/nova/)
                                  ├── Identity (SOUL.md, IDENTITY.md, USER.md)
                                  ├── Memory (Hindsight MCP + curated MEMORY.md)
                                  ├── Skills (/bootstrap, /standup, /research, /remind)
                                  └── Subagents (cron-worker, researcher, coder)
```

Each agent has:
- **Personality & identity** — name, creature type, vibe, tone, values
- **Long-term memory** — semantic search via Hindsight (Docker container per agent)
- **Working memory** — curated 50-line MEMORY.md cheat sheet, always in context
- **Skills & subagents** — onboarding, daily standups, research, reminders, background workers
- **Safety rules** — no exfiltration, ask before destructive ops, trash instead of delete
- **Optional Telegram** — via ClaudeClaw daemon plugin

## Quick Start

### Prerequisites

- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated
- `/bootstrap` will help you install everything else (Docker, LLM provider, etc.)

### Create an Agent

```bash
# Clone the repo
git clone https://github.com/seanchiuai/openclaude.git
cd openclaude

# Scaffold an agent named "nova" (default Hindsight port: 8888)
./scripts/setup.sh nova

# Start a session
cd ~/.openclaude/agents/nova
claude

# Run onboarding — handles everything:
# Docker, Hindsight, API keys, cron jobs, identity
/bootstrap
```

`setup.sh` only creates the directory structure. All interactive setup happens
inside Claude Code via `/bootstrap` — it walks you through Docker installation,
LLM provider selection, Hindsight health checks, cron registration, and
(optionally) agent identity discovery.

### Multiple Agents

Each agent gets its own Hindsight container on a different port:

```bash
./scripts/setup.sh nova 8888
./scripts/setup.sh aria 8889
```

## Project Layout

```
templates/
  workspace/          # Agent identity templates
    IDENTITY.md       #   Name, creature, vibe, emoji
    SOUL.md           #   Persona, tone, values, boundaries
    AGENTS.md         #   Operating rules, memory policy, red lines
    USER.md           #   Human's preferences
    TOOLS.md          #   Local environment (SSH hosts, devices)
    HEARTBEAT.md      #   Periodic checklist
    MEMORY.md         #   Curated cheat sheet (50-line cap)
  claude/             # Claude Code config templates
    CLAUDE.md         #   Bridge file (@imports workspace files)
    .mcp.json         #   Hindsight MCP server config
    settings.json     #   Hooks (session logging, memory-size cap)
    skills/           #   bootstrap, standup, research, remind
    agents/           #   cron-worker, researcher, coder
    rules/            #   safety, messaging

scripts/
  setup.sh            # Scaffold agent directory from templates
  uninstall.sh        # Remove agent (with optional data cleanup)
  log-session.sh       # SessionEnd hook: append session to manifest
  nightly-memory.sh    # Nightly cron: process transcripts + daily log
  check-memory-size.sh  # PreToolUse hook: enforce 50-line MEMORY.md cap
  health-check.sh     # Cron: verify Hindsight + ClaudeClaw alive
  export-agent.sh     # Bundle agent + memory for migration
  import-agent.sh     # Restore agent on new machine
  test/               # Bats test suites

docs/
  setup.md            # Detailed setup guide + troubleshooting
  plans/              # Architecture docs
```

### Installed Agent Structure

```
~/.openclaude/agents/nova/
  .claude/
    CLAUDE.md             # Bridge: @imports workspace files
    .mcp.json             # Hindsight MCP server
    settings.json         # Hooks config
    skills/               # /bootstrap, /standup, /research, /remind
    agents/               # cron-worker, researcher, coder
    rules/                # safety, messaging
  workspace/
    IDENTITY.md           # Agent's discovered identity
    SOUL.md               # Core persona & values
    AGENTS.md             # Operating rules & memory policy
    USER.md               # Your preferences (built over time)
    TOOLS.md              # Environment specifics
    HEARTBEAT.md          # Periodic tasks
    MEMORY.md             # Curated cheat sheet (50-line cap)
    memory/               # Daily logs (auto-generated)
```

## Architecture

### Memory System

OpenClaude uses a two-tier memory architecture:

| Layer | Purpose | Mechanism |
|-------|---------|-----------|
| **Hindsight** (primary) | Long-term semantic memory | Docker container, MCP tools: `retain`, `recall`, `reflect` |
| **MEMORY.md** (curated) | Critical context always in view | 50-line file, enforced by PreToolUse hook |

The agent calls `retain` during conversations to store facts immediately. A nightly cron (`nightly-memory.sh`) acts as a safety net, processing session transcripts in batch to catch missed facts and generating daily logs.

### Hooks

| Hook | Trigger | Script | Purpose |
|------|---------|--------|---------|
| SessionEnd | Session exits | `log-session.sh` | Append session metadata to manifest for nightly processing |
| PreToolUse | Write/Edit called | `check-memory-size.sh` | Reject MEMORY.md edits if over 50 lines |

### Skills

| Skill | Purpose |
|-------|---------|
| `/bootstrap` | Full onboarding: Docker, Hindsight, cron, connectivity, identity |
| `/standup` | Daily git summary across projects |
| `/research` | Deep research combining web search + memory recall |
| `/remind` | Task & reminder management via Hindsight temporal recall |

### Subagents

| Agent | Model | Access | Purpose |
|-------|-------|--------|---------|
| `cron-worker` | Haiku | Write to `memory/` only | Daily logs, cleanup, heartbeat |
| `researcher` | Sonnet | Read-only | Web research, structured reports |
| `coder` | Sonnet | Full | Code changes with tests + commits |

## Agent Management

### Export / Import

Move an agent to another machine:

```bash
# On source machine
./scripts/export-agent.sh nova
# Creates nova-export-2026-03-23.tar.gz

# On target machine
./scripts/import-agent.sh nova-export-2026-03-23.tar.gz
```

**Note:** API keys and Telegram tokens are not included in exports. Re-configure them after import.

### Health Checks

Cron jobs are registered automatically during `/bootstrap`. To verify:

```bash
crontab -l
# Should show nightly-memory (2am) and health-check (every 5min)
```

### Uninstall

```bash
# Remove agent config only
./scripts/uninstall.sh nova

# Remove agent + Hindsight container + data
./scripts/uninstall.sh nova --remove-data
```

## Design Principles

- **All bash, no build step.** Zero runtime dependencies beyond Claude Code CLI and Docker.
- **One container per agent.** Hard memory isolation between agents (~200MB RAM each).
- **Agent owns its identity.** Personality emerges through conversation, not configuration.
- **Retain immediately, not in batches.** Facts go to Hindsight as they happen.
- **Trash, don't delete.** Use `trash` instead of `rm` for recoverability.
- **Ask before acting externally.** Messages, API calls, and system changes require confirmation.

## Testing

Tests use [bats](https://github.com/bats-core/bats-core) (Bash Automated Testing System):

```bash
# Run all tests
bats scripts/test/

# Run specific test suite
bats scripts/test/setup.bats
bats scripts/test/log-session.bats
bats scripts/test/nightly-memory.bats
bats scripts/test/check-memory-size.bats
bats scripts/test/health-check.bats
```

## Documentation

- **[Setup Guide](docs/setup.md)** — Prerequisites, detailed setup, troubleshooting
- **[Architecture Plan](docs/plans/2026-03-23-openclaude-v2-architecture.md)** — Full technical specification

## License

MIT
