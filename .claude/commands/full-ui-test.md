---
description: Test the entire user-flow and all functionalities for errors.
argument-hint: [feature to test]
---

# Command: Full UI Check

1. Start the app (`npm run dev` or project-appropriate command).
2. Test core features using browser MCP tools (cursor-ide-browser or cursor-browser-extension).
3. If a blocking error occurs, stop testing.
4. After testing, generate a report grouped by severity:
   - **Critical**: Prevents core user flows or app startup
   - **Major**: Breaks major features but app still runs
   - **Minor**: Cosmetic issues, small UI bugs, non-blocking annoyances
   - **Suggestions**: UX improvements, confusing flows

Notes:
- If you cannot perform an action (e.g., login), STOP and ask the human. Continue after they say "done."
- If the app requires long processing after input, stop and tell user to prompt you for the report when ready.
- If no issues found, note in CHANGELOG.md or inform user (skip full report).
- Test all major functionalities minimally—don't exhaustively test every small feature.
