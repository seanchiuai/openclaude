---
description: Refactor a specific area of the codebase safely
argument-hint: <directory or module to refactor>
---

# Refactor

**Target: $ARGUMENTS**

If no target was specified, ask the user which directory or module to refactor. Do NOT refactor the entire codebase at once.

## Procedure

1. **Scope**: Analyze and map the target area — files, exports, dependencies, and consumers.
2. **Identify issues**: Code smells, duplication, inconsistent patterns, dead code, outdated patterns.
3. **Propose plan**: Present a prioritized list of changes. Wait for approval before proceeding.
4. **Execute**: Refactor module-by-module:
   - Modernize code patterns (e.g., async/await, composables over mixins)
   - Remove dead code, merge similar utilities
   - Commit each logical change separately with clear messages
5. **Verify**: Run `npm run type-check` after changes to ensure nothing broke.

Do NOT change code outside the target area unless it's a direct consumer that needs updating.
