---
description: Show task status for the current issue
---

# Status Update

Read `.claude/docs/issue-tasks.md` (primary) or fall back to the CLAUDE.md "Known Issues" section if the task file doesn't exist.

Present a single consolidated status table with these columns:
- **#** — item number
- **Issue** — short description
- **Status** — DONE, IN PROGRESS, or OPEN

Mark DONE items with ~~strikethrough~~ in the Issue column. Sort by: DONE last, then by status (IN PROGRESS first).

After the table, add a one-line summary: "X/Y complete. Next: [brief description of highest priority open item or 'all done']."

Do NOT explain what each issue is in detail — keep it concise.

$ARGUMENTS
