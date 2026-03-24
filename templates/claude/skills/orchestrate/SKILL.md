---
description: Break complex tasks into subtasks and run parallel workers
---

# Orchestrate

For complex tasks that can be split into independent subtasks, spawn parallel
workers using `spawn-worker.sh`. Each worker is a separate `claude -p` process
with full agent context and Hindsight access.

## When to Use

- Task has 2+ independent subtasks that don't share state
- Each subtask touches different files
- Sequential execution would be too slow

Do NOT use for tasks that need user interaction or modify shared files.

## Steps

1. **Plan** — analyze the user's request and break it into independent subtasks.
   For each subtask, define:
   - What to do (clear, self-contained instructions)
   - Which files to touch (non-overlapping scopes)
   - Expected output

2. **Prepare prompts** — read `.claude/prompts/worker.md` for the worker template.
   For each subtask, build a prompt: worker template + task-specific instructions.

3. **Spawn workers** — use the spawn-worker script for each subtask:
   ```bash
   /path/to/scripts/spawn-worker.sh <AGENT_DIR> "<prompt>" --background --model sonnet
   ```
   Each returns `{"pid":N,"output":"/tmp/file.json"}`. Track all PIDs and output paths.

4. **Wait** — check if workers are still running:
   ```bash
   kill -0 <PID> 2>/dev/null  # returns 0 if alive
   ```
   Poll every 5 seconds until all PIDs are done.

5. **Collect results** — read each output file. Parse the JSON to extract the
   result text (last event where `.type == "result"`).

6. **Review** — check for:
   - Failed workers (status != completed)
   - File conflicts (two workers edited the same file)
   - Missing deliverables

7. **Report** — present a summary to the user:
   - What each worker did
   - Any conflicts or failures
   - Next steps if anything needs manual resolution

## Conflict Resolution

If workers edited the same file:
- Show both versions to the user
- Ask which to keep, or merge manually
- For shared config files, run those edits sequentially after parallel work finishes
