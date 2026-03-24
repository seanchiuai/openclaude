---
description: First-run onboarding — set up everything and figure out who you are
---

# Bootstrap

This is your first conversation. You're going to get everything set up — the
infrastructure, the memory, the identity. All of it, right here.

There is no memory yet. This is a fresh workspace, so it's normal that memory
files don't exist until you create them.

---

## First: Create a Task List

Before doing anything, use `TaskCreate` to create tasks for tracking progress.
Create these tasks up front (mark each as completed as you finish it):

1. **Preflight** — verify skills, plugins, and config are correct
2. **Docker** — check Docker is installed and running
3. **Hindsight** — set up LLM provider, start container, verify health
4. **Cron jobs** — register nightly-memory and health-check
5. **Connect** — set up Telegram + ClaudeClaw daemon
6. **Identity** — name, creature, vibe, emoji, SOUL.md

This lets the user see where you are in the process at a glance.

---

## Phase 0: Preflight Check

Run these checks silently before anything else. If any fail, report all
issues together and help the user fix them before proceeding.

### 1. ClaudeClaw Plugin

```bash
claude plugins list 2>/dev/null | grep -i claudeclaw
```

- **Installed →** Good.
- **Not installed →** Tell the user: "ClaudeClaw is needed for Telegram and
  daemon mode. Install it now?" Then run:
  `claude plugin marketplace add moazbuilds/claudeclaw`

### 2. Agent Directory Structure

Verify the expected files exist from `setup.sh`:

```bash
# All of these should exist
ls .claude/CLAUDE.md .claude/.mcp.json .claude/settings.json
ls .claude/skills/bootstrap/SKILL.md
ls workspace/IDENTITY.md workspace/SOUL.md workspace/AGENTS.md workspace/USER.md workspace/MEMORY.md
```

- **All present →** Good.
- **Missing files →** Something went wrong with setup.sh. List what's missing
  and suggest re-running setup from the openclaude repo directory.

### 3. Config Conflicts

Check the user's global Claude Code config for anything that might clash
with the agent's config:

```bash
# Global settings that might override agent settings
cat ~/.claude/settings.json 2>/dev/null
# Global MCP servers that might conflict
cat ~/.claude/.mcp.json 2>/dev/null
```

Look for:
- **Duplicate hook matchers** — global hooks on `SessionEnd` or `PreToolUse`
  (Write|Edit) that might interfere with the agent's hooks
- **Conflicting MCP server names** — a global `hindsight` MCP server pointing
  to a different port/agent would shadow the agent's config
- **Conflicting skills** — global skills with the same names as agent skills
  (bootstrap, standup, research, remind, etc.)

If conflicts are found, explain each one and suggest how to resolve:
- Move the conflicting global config to project-level, or
- Rename the agent's version, or
- Remove the global one if it's not needed

### 4. Preflight Report

Show results:

```
Preflight
━━━━━━━━━
ClaudeClaw:  ✓ installed
Agent files: ✓ complete
Config:      ✓ no conflicts
```

If anything failed, fix it before moving on. Don't proceed to Phase 1 with
known issues.

---

## Phase 1: System Check

After preflight passes, run infrastructure diagnostics. Check each of these
silently and build a status report to show the user:

### 1. Docker

```bash
command -v docker && docker info
```

- **Not installed →** Tell the user: "Hindsight (your memory system) needs Docker.
  Install it from https://docs.docker.com/get-docker/ — I'll wait." Then ask them
  to type `! docker info` once it's installed to verify.
- **Installed but not running →** Tell them to start Docker Desktop (or
  `sudo systemctl start docker` on Linux). Wait for them to confirm.
- **Running →** Good. Move on.

### 2. Hindsight Container

Check if the Hindsight container is already running:

```bash
# Get the agent name and port from .mcp.json
cat .claude/.mcp.json
```

Extract the agent name and port from the MCP config URL
(`http://localhost:PORT/mcp/AGENT_NAME/`).

```bash
docker ps -a --filter "name=hindsight-AGENT_NAME" --format '{{.Names}} {{.Status}}'
curl -sf http://localhost:PORT/docs
```

- **Running and healthy →** Great, skip to Phase 2.
- **Exists but stopped →** Restart it: `docker restart hindsight-AGENT_NAME`
- **Doesn't exist →** Needs LLM provider setup (Phase 1.3).
- **Running but unhealthy →** Check logs: `docker logs hindsight-AGENT_NAME --tail 20`
  Show the user and help diagnose.

### 3. LLM Provider for Hindsight

_Only if the Hindsight container doesn't exist yet._

Hindsight needs an LLM for entity resolution (extracting structured facts from
memories). Ask the user which provider they want:

Present this menu:

> Hindsight needs an LLM for entity resolution. Which provider do you want to use?
>
> 1. **Gemini** — Free tier, fast. Get a key at https://ai.google.dev
> 2. **Groq** — Free tier, fast. Get a key at https://groq.com
> 3. **Ollama** — Local, no API key needed. (Broken on macOS Tahoe — Metal bug)
> 4. **LM Studio** — Local, no API key. Requires LM Studio running.
> 5. **OpenAI** — Paid. Needs API key.
> 6. **Anthropic** — Paid. Needs API key.
> 7. **Skip** — Set up Hindsight later.

Based on their choice:
- **Gemini/Groq/OpenAI/Anthropic →** Ask for their API key.
- **Ollama →** Base URL is `http://host.docker.internal:11434/v1`, model `llama3.2`.
  Check if Ollama is actually running: `curl -sf http://localhost:11434/api/tags`
- **LM Studio →** Base URL is `http://host.docker.internal:1234/v1`.
  Check if LM Studio is running: `curl -sf http://localhost:1234/v1/models`
- **Skip →** Note that memory features won't be available. Move on.

### 4. Start Hindsight

_Only if container doesn't exist and provider isn't "skip"._

First check for port conflicts:

```bash
lsof -i :PORT
```

If the port is in use, tell the user what's using it and suggest they either
stop that process or you can try the next available port.

Then pull the image if needed and start the container:

```bash
# Pull if not cached
docker image inspect ghcr.io/vectorize-io/hindsight:latest || \
  docker pull ghcr.io/vectorize-io/hindsight:latest

# Start container
docker run -d \
  --name "hindsight-AGENT_NAME" \
  --restart unless-stopped \
  --add-host host.docker.internal:host-gateway \
  -p PORT:8888 \
  -e "HINDSIGHT_API_LLM_PROVIDER=PROVIDER" \
  -e "HINDSIGHT_API_LLM_API_KEY=KEY" \
  -v "$HOME/.hindsight-AGENT_NAME:/home/hindsight/.pg0" \
  ghcr.io/vectorize-io/hindsight:latest
```

Add `-e HINDSIGHT_API_LLM_BASE_URL=...` and `-e HINDSIGHT_API_LLM_MODEL=...`
only if applicable (Ollama, LM Studio).

Wait for health (poll `/docs` endpoint, up to 60 seconds):

```bash
for i in $(seq 1 30); do
  curl -sf http://localhost:PORT/docs && break
  sleep 2
done
```

If it doesn't come up, show the user the container logs and help debug.

### 5. Cron Jobs

Check if cron jobs are already registered:

```bash
crontab -l 2>/dev/null
```

Look for entries containing `nightly-memory.sh` and `health-check.sh` for this
agent. If missing, tell the user you'd like to add:

- **Nightly memory** (2am) — processes session transcripts into Hindsight
- **Health check** (every 5 min) — restarts Hindsight if it goes down

Ask for confirmation, then add them. You'll need the path to the openclaude
repo — check if the CLAUDE.md in the project root has it, or ask the user.

### 6. Status Report

Show the user a clean summary:

```
System Status
━━━━━━━━━━━━━
Docker:     ✓ running
Hindsight:  ✓ healthy (port 8888, gemini)
Cron:       ✓ nightly-memory + health-check
MCP:        ✓ connected
```

If anything failed, show what's broken and offer to help fix it. Don't move to
Phase 2 until the user is satisfied or explicitly wants to skip.

---

## Phase 2: Connect

The default is **Telegram + always-on daemon** (ClaudeClaw with heartbeats and
cron jobs). Set this up unless the user explicitly opts out.

Tell the user:

> "Next: let's get you on Telegram so I can run in the background, do heartbeats,
> and cron jobs. You'll need a bot token from @BotFather. If you'd rather skip
> this and only use interactive Claude Code sessions, just say so."

- **Default (Telegram + always on) →** Guide them through @BotFather bot creation,
  configure the ClaudeClaw settings (token, user ID, heartbeat, timezone), then
  **run `/claudeclaw:start` automatically** to launch the daemon. Don't ask the
  user to run it manually — just do it.
- **Claude Code only →** Skip connectivity. They can always set it up later by
  running `/bootstrap` again.

---

## Phase 3: Identity (Optional)

If Telegram was set up and ClaudeClaw started in Phase 2, **tell the user
identity setup will happen on Telegram**:

> "That's everything. I'm running on Telegram now — message me there and
> we'll figure out who I am. Or we can do it right here if you prefer."

- **Default (Telegram) →** End here. Identity happens in the first Telegram session.
- **Here instead →** If the user explicitly asks to do it now, do the identity
  setup below.

If Telegram was **not** set up (Claude Code only), ask if they want to do
identity now or in a future session.

### If They Want to Do It Now

Read `../workspace/IDENTITY.md`, `../workspace/USER.md`, and
`../workspace/SOUL.md`. These files have blank fields and prompts that
tell you exactly what to fill in. Walk through them conversationally
with the user — don't interrogate, don't be robotic, just talk.

Offer suggestions if they're stuck. Have fun with it.

### When Done

Delete `../workspace/BOOTSTRAP.md` if it exists. You don't need a bootstrap
script anymore — you're you now.

---

## Troubleshooting Guide

If things go wrong during setup, here's how to help:

### "Docker is not installed"
→ Direct them to https://docs.docker.com/get-docker/
→ macOS: `brew install --cask docker` or download Docker Desktop
→ Linux: `curl -fsSL https://get.docker.com | sh`

### "Docker daemon not running"
→ macOS: Open Docker Desktop app
→ Linux: `sudo systemctl start docker`

### "Port already in use"
→ `lsof -ti :PORT` to find the process
→ If it's another Hindsight container, offer to reuse it
→ Otherwise suggest a different port and update `.mcp.json`

### "Hindsight won't start"
→ Check logs: `docker logs hindsight-AGENT_NAME --tail 30`
→ Common: bad API key, provider down, network issues
→ If API key issue, help them get a new key

### "Hindsight starts but MCP tools don't work"
→ Verify the URL in `.mcp.json` matches the actual port
→ Try `curl http://localhost:PORT/mcp/AGENT_NAME/` directly
→ May need to restart the Claude Code session after config changes

### "Cron not working"
→ `crontab -l` to verify entries exist
→ Check script paths are absolute and scripts are executable
→ `chmod +x` the scripts if needed

---

_Good luck out there. Make it count._
