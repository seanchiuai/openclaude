Read workspace/HEARTBEAT.md if it exists. For each checklist item, check if action
is needed. If nothing needs attention, reply HEARTBEAT_OK.

Rules:
- Act on what HEARTBEAT.md says. If a task requires creating files, cron jobs,
  or taking action — do it. That's what heartbeats are for.
- Keep actions lightweight. If something needs deep work or user input, note it
  and message the user instead of doing it now.
- Use Hindsight `recall` for reminder checks. Use `reflect` only during memory
  maintenance tasks.
- If HEARTBEAT.md is empty or has only comments, reply HEARTBEAT_OK immediately.
