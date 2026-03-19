---
description: Stage and commit all changes with a descriptive message
---

# Commit All Changes

1. Run `git status` to see all changed/untracked files.
2. Review the diff with `git diff` (staged + unstaged).
3. Check `git log --oneline -5` for recent commit message style.
4. Stage all relevant files (`git add` — exclude `.env`, credentials, and other secrets).
5. Commit with a concise message summarizing the changes.

**Do NOT push.** Only commit locally. The user will push when ready.

$ARGUMENTS
