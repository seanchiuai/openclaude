---
description: Manage heartbeat checklist — add, remove, and list periodic tasks
---

# Heartbeat

Manage `workspace/HEARTBEAT.md` — the periodic checklist that runs every heartbeat
cycle via ClaudeClaw.

## Commands

Parse the user's request to determine the action:

### "add X to heartbeat" / "check X every heartbeat"

1. Read `workspace/HEARTBEAT.md`
2. Add the new check as a bullet under `## Checks`
3. Confirm what was added
4. Remind the user: heartbeat must be enabled via `/claudeclaw:config heartbeat on`

### "remove X from heartbeat" / "stop checking X"

1. Read `workspace/HEARTBEAT.md`
2. Find and remove the matching entry
3. Confirm what was removed

### "list heartbeat tasks" / "what does the heartbeat check"

1. Read `workspace/HEARTBEAT.md`
2. List all checklist items
3. Show whether heartbeat is enabled (check `.claude/claudeclaw/settings.json`)
4. Show the interval and quiet hours

### "heartbeat on" / "heartbeat off"

1. Read `.claude/claudeclaw/settings.json`
2. Set `heartbeat.enabled` to true/false
3. Write the updated settings
4. Confirm the change — ClaudeClaw hot-reloads within 30 seconds

## Notes

- Each heartbeat item costs tokens — keep the list focused
- Items should be quick checks, not deep work
- If an item needs user input, phrase it as "notify user about X" not "do X"
- HEARTBEAT.md changes take effect on the next heartbeat cycle
