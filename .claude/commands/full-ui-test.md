---
description: Test the entire user-flow and all functionalities for errors
argument-hint: [feature to test]
---

# Full UI Test

1. Verify the dev server is running by checking `dev.log` or curling `http://localhost:3000/`.
2. Test core features using browser automation tools (claude-in-chrome MCP).
3. If a blocking error occurs, stop testing.
4. After testing, generate a report grouped by severity:
   - **Critical**: Prevents core user flows or app startup
   - **Major**: Breaks major features but app still runs
   - **Minor**: Cosmetic issues, small UI bugs, non-blocking annoyances
   - **Suggestions**: UX improvements, confusing flows

Notes:
- If you cannot perform an action (e.g., login), STOP and ask the human. Continue after they say "done."
- If the app requires long processing after input, stop and tell user to prompt you for the report when ready.
- Test all major functionalities minimally — don't exhaustively test every small feature.

$ARGUMENTS
