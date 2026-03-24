---
description: Show agent health — Hindsight, memory, cron, heartbeat, ClaudeClaw
---

# Status

Show the health and status of all agent systems.

## Steps

Run these checks and present a single status report:

### 1. Hindsight Memory

Read `.claude/.mcp.json` to get the Hindsight URL, then check health:
```bash
curl -sf <hindsight-url-from-mcp-json>/docs
```
- If responds: report "Hindsight: healthy"
- If not: report "Hindsight: DOWN" and suggest checking Docker logs

### 2. MEMORY.md

- Read `workspace/MEMORY.md` and count lines
- Report: "MEMORY.md: N/50 lines"

### 3. Daily Logs

- Check `workspace/memory/` for recent daily log files
- Report latest log date, or "no daily logs yet"

### 4. Session Manifest

- Check `workspace/memory/sessions.jsonl`
- Count total sessions logged
- Report last session date

### 5. ClaudeClaw

- Check `.claude/claudeclaw/settings.json` for heartbeat and Telegram status
- Report: heartbeat enabled/disabled, interval, Telegram configured yes/no

### 6. Cron Jobs

- List `.claude/claudeclaw/jobs/*.md` files
- For each: show name and schedule
- Also check system crontab: `crontab -l 2>/dev/null | grep this agent`

### 7. Workspace Files

Check that all core files exist:
- IDENTITY.md, SOUL.md, AGENTS.md, USER.md, TOOLS.md, HEARTBEAT.md, MEMORY.md
- Report any missing files as warnings

## Output Format

```
Agent Status: this agent
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Hindsight:    healthy | DOWN
MEMORY.md:    N/50 lines
Daily logs:   latest YYYY-MM-DD | none
Sessions:     N logged (last: YYYY-MM-DD)
Heartbeat:    enabled (30min) | disabled
Telegram:     configured | not configured
Cron jobs:    N jobs (list names)
Workspace:    all files present | missing: [list]
```
