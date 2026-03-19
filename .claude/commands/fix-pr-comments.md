---
description: Read unresolved PR review comments and fix them automatically
argument-hint: [--dry-run]
---

# Fix PR Review Comments

## Instructions

1. **Find the current PR** for this branch using `gh pr list --head $(git branch --show-current) --json number,url --jq '.[0]'`. If no PR exists, tell the user and stop.

2. **Get the last commit timestamp** using `git log -1 --format=%aI` to know the cutoff.

3. **Fetch all review comments** on the PR using `gh api` to get both:
   - PR review comments (inline code comments): `gh api repos/{owner}/{repo}/pulls/{number}/comments --paginate`
   - PR issue comments (top-level): `gh api repos/{owner}/{repo}/issues/{number}/comments --paginate`

4. **Filter to actionable comments** posted AFTER the last commit date. Exclude:
   - Comments authored by the PR author themselves (get PR author from PR data)
   - Comments from infrastructure bots that don't contain code suggestions (e.g., supabase[bot], cursor[bot], vercel[bot], netlify[bot])
   - Comments that are just approvals, emoji reactions, or "LGTM"
   - Already resolved review threads

   **Include** comments from code review bots (e.g., chatgpt-codex-connector[bot], coderabbit[bot], copilot[bot], etc.) — these often contain valid, actionable code suggestions like bug fixes, missing edge cases, or logic errors. Treat them the same as human reviewer comments.

5. **For each actionable comment**, understand what change is requested:
   - If it references a specific file/line, read that file and understand the context
   - Group related comments together (e.g., multiple comments about the same issue)

6. **Apply the fixes** — make the code changes requested by each comment. If a comment is ambiguous or you're unsure, skip it and list it at the end as "needs manual review."

7. **Validate fixes** — after applying changes, run these checks on every modified file:
   - **Guard pattern scan**: If the fix involves auth, sessions, or API calls, grep the surrounding module for unguarded calls to the same API/auth pattern. Ensure the fix is applied consistently (e.g., if you add an auth guard to one function, check sibling functions in the same file).
   - **Race condition check**: If the fix involves reactive state (refs, watchers, onMounted), trace the data flow to verify no consumer can observe stale/uninitialized state. Look for `{ immediate: true }` watchers, module-level auto-execution, and composables that trigger side effects on import.
   - **Ripple effect scan**: Search the codebase for other callers/importers of the changed function. If the fix changes a function's contract (new guard, new parameter, different return), verify all call sites still work.
   - Report any secondary issues found as additional fixes or "needs manual review."

8. **Report what you did** — summarize each comment and what fix was applied, including any secondary issues found during validation.

9. If `--dry-run` is passed via $ARGUMENTS, only report what you WOULD fix without making changes.

10. Unless `--dry-run`, after applying all fixes, commit with a message like:
   ```
   fix: address PR review feedback

   - <brief description of each fix>
   ```

## Important

- Do NOT push automatically. Just commit locally so the user can review.
- If there are no new comments since the last commit, say so and stop.
- Be precise with fixes. Don't over-engineer or refactor beyond what's requested.
- When fixing one instance of a bug, always check for the same pattern elsewhere in the changed files.

$ARGUMENTS
