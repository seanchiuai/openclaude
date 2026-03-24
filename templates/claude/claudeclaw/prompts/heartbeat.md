Read workspace/HEARTBEAT.md if it exists. For each checklist item, check if action
is needed. If nothing needs attention, reply HEARTBEAT_OK.

Rules:
- Do NOT create files, modify cron jobs, or install skills during heartbeats
  unless the user explicitly added that task to HEARTBEAT.md themselves.
- Keep actions lightweight. If something needs deep work, note it for the user
  instead of doing it now.
- Use Hindsight `recall` for reminder checks. Use `reflect` only during memory
  maintenance tasks.
- If HEARTBEAT.md is empty or has only comments, reply HEARTBEAT_OK immediately.
