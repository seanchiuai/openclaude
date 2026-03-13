---
description: Decompose and autonomously complete the current task via Ralph Loop
model: opus
---

# /autocomplete-task

Reads the current task context, decomposes it into action items with test criteria, then starts a Ralph Loop to work through them autonomously.

Run this after `/new-issue` has scaffolded your worktree, or in any directory with a task to do.

## Procedure

### 1. Understand the task

Read these files (if they exist) to build context:
- `CLAUDE.md` — project/issue context
- `.claude/docs/issue-tasks.md` — existing task breakdown

### 2. Decompose (if items are empty or placeholders)

If `issue-tasks.md` has no real items yet:

**Research:**
- Read relevant skill docs (`.claude/skills/`)
- Explore the codebase: Glob, Grep, Read relevant files
- Understand existing patterns and how the task fits

**Break into 3-7 ordered action items.** Each item needs:
- A clear, actionable description (one thing to do)
- **Where**: specific files and line numbers to read/modify
- **Pattern**: existing code to follow (if non-obvious)
- **Test**: a runnable command that passes or fails (e.g. `grep "text" file.ts`, `npm run type-check`, `test -f path`). Avoid subjective criteria like "verify it works" — if no command exists, use grep/test/wc to check for expected output in files.

Order by dependency: foundational changes first, then features, then integration.

The goal is self-contained items: a cold-start Claude with no memory of previous iterations should be able to pick up any item and know exactly where to look, what pattern to follow, and how to verify.

**Identify constraints:**
- External dependencies (API keys, services)
- User decisions needed
- Breaking changes to avoid

**Write to `.claude/docs/issue-tasks.md`:**

```markdown
---
task: <title>
issue: <number or "none">
branch: <branch-name>
created: <YYYY-MM-DD>
status: in_progress
---

# <Title>

## Objective
<What success looks like — 1-3 sentences>

## Constraints
- <constraint>

## Items
- [ ] 1. <action>
  - Where: <files and lines to read/modify>
  - Pattern: <existing code to follow>
  - Test: <runnable command>
- [ ] N. Verify integration
  - Test: npm run type-check && npm run lint:fix

## Done

## Findings
```

### 3. Show plan, confirm, start Ralph Loop

Present the items to the user. Ask them to review. Then start:

```
/ralph-loop "Read .claude/docs/issue-tasks.md. Pick next unchecked item, implement it, verify against test criteria, mark done with summary, log findings, commit. If all items done: <promise>TASK COMPLETE</promise>" --max-iterations 20
```

$ARGUMENTS
