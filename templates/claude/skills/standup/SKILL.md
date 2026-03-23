---
description: Daily standup — summarize recent git activity
---

# Standup

Generate a daily standup summary by checking recent git activity across known projects.

## Steps

1. Read `../workspace/TOOLS.md` for project directories
2. For each project directory, run:
   ```bash
   git -C <dir> log --oneline --since="yesterday" --author="$(git config user.name)"
   ```
3. Summarize: what was done, what's in progress, any blockers
4. If Hindsight is available, `recall` recent decisions or context that might be relevant
5. Present a concise standup report

Keep it brief. This is a status check, not a novel.
