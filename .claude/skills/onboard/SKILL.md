---
description: Set up OpenClaude — create agents and guide user through onboarding
---

# Onboard

This skill is only available from the openclaude repo directory. It walks the
user through creating agents and getting them running.

---

## First: Create a Task List

Use `TaskCreate` to track progress. Start with these tasks (update as you learn
what the user needs):

1. **Plan agents** — figure out how many agents the user wants and their names/ports
2. **Scaffold agents** — run setup.sh for each agent
3. **Guide to bootstrap** — tell user how to bootstrap each agent

Mark each as completed as you go.

---

## Step 1: Welcome & Plan

Greet the user. Explain what OpenClaude is in one sentence, then ask what they
need:

> "OpenClaude creates persistent AI agents with long-term memory. Let's get
> you set up. How many agents do you want, and what should they be called?"

Help them decide:
- **One agent** is the common case — a personal assistant
- **Multiple agents** are for separate concerns (work vs personal, different
  projects, etc.)
- Each agent gets its own memory, identity, and Hindsight container

For each agent, confirm:
- **Name** (lowercase, no spaces — used for directory and container names)
- **Hindsight port** (default 8888, increment for each additional agent: 8889, 8890...)

## Step 2: Scaffold

For each agent, run setup.sh:

```bash
./scripts/setup.sh AGENT_NAME PORT
```

Show the user the output. If it fails (e.g. agent already exists), help them
resolve it — rename, remove the old one, or skip.

## Step 3: Guide to Bootstrap

Once all agents are scaffolded, tell the user what to do next. For each agent:

```bash
cd ~/.openclaude/agents/AGENT_NAME && echo "/bootstrap" | claude --dangerously-skip-permissions -p
```

Explain that `/bootstrap` will handle everything else inside Claude Code:
- Docker installation and setup
- LLM provider for Hindsight (API key)
- Starting the Hindsight container
- Cron job registration
- Connectivity (Telegram, ClaudeClaw)
- Agent identity (name, creature, vibe — optional, can do later)

If they only created one agent, keep it simple:

> "Agent scaffolded. Now run this to finish setup:"
> ```bash
> cd ~/.openclaude/agents/AGENT_NAME && echo "/bootstrap" | claude --dangerously-skip-permissions -p
> ```

If they created multiple agents, list them all with their ports and the
commands to bootstrap each one. Suggest doing them one at a time.

---

## If the User Needs Help

- **"What's Hindsight?"** — Semantic memory system. Stores facts, retrieves
  them by meaning. Runs in Docker. Each agent gets its own container.
- **"What's ClaudeClaw?"** — Daemon plugin for Claude Code. Lets your agent
  run in the background, respond on Telegram, run cron jobs.
- **"Do I need Docker?"** — Yes, for memory. `/bootstrap` will help install it.
- **"Can I add more agents later?"** — Yes, just run `./scripts/setup.sh` again
  from the openclaude repo with a new name and port.
