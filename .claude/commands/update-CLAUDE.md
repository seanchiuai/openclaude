---
description: Update CLAUDE.md when major codebase changes occur
argument-hint: [section or "all"]
---

# Command: Update CLAUDE.md

Sync CLAUDE.md with current codebase state. **Only update sections with actual discrepancies** - don't rewrite for the sake of rewriting.

## Usage

```bash
/update-CLAUDE              # Check all sections, update as needed
/update-CLAUDE tech-stack   # Update Tech Stack section only
/update-CLAUDE phases       # Update Development Phases section only
/update-CLAUDE skills       # Update Skills section only
/update-CLAUDE all          # Full sync of all sections
```

## CLAUDE.md Structure

The file has two types of content:

### Constant Sections (rarely change)

These sections should NOT be modified unless the project fundamentally changes:

- **Development Rules** — project rules and constraints
- **Environment Variables** — env var names (not values)

### Variable Sections (update when codebase changes)

- **Current Focus** — update when the issue objective changes
- **Architecture** — update when system design changes
- **File Map** — update when files are added, removed, or significantly modified
- **Key Context** — update when important technical context changes
- **Known Issues** — update when issues are found or resolved

## Update Process

### Step 1: Gather Current State

Read the current CLAUDE.md and identify all variable sections present.

### Step 2: Compare Against Codebase

For each variable section:
1. Read current CLAUDE.md section
2. Compare against codebase reality (file existence, line counts, etc.)
3. Identify discrepancies only

### Step 3: Update Only Discrepancies

**File Map updates:**
- Verify listed files still exist
- Update line counts if significantly changed
- Add new files relevant to the current focus
- Remove files that no longer exist

**Key Context / Known Issues updates:**
- Remove resolved issues
- Add new discoveries

**Do NOT change:**
- Formatting/indentation
- Section ordering
- Wording of constant sections (Development Rules, etc.)
- Line breaks or spacing

## Validation Checks

Before updating, verify:

### File Map
```
For each file listed in File Map:
  - Does the file still exist?
  - Is the line count approximately correct?
  - Is the purpose description accurate?
```

### Environment Variables
```
For each env var listed:
  - Is it referenced in code?
  - Is the description accurate?
```

## Output Format

```markdown
## CLAUDE.md Sync Report

### File Map
- ✓ 6 files verified
- ⚠️ Updated: server/utils/avatar/hedra.ts line count 530 → 580
- 🆕 Added: composables/voice/useAvatarFallback.ts

### Key Context
- ✓ No changes needed

### Known Issues
- Removed: "Audio sync delay" (resolved in abc123)

### Changes Made
- Updated File Map (1 line count, 1 new file)
- Removed 1 resolved known issue

✅ CLAUDE.md updated (or "No changes needed")
```

## What NOT to Update

1. **Development Rules** — these are project rules, not state
2. **Specific file paths in examples** — unless files moved
3. **Section ordering or formatting** — keep consistent

## When to Run

**Run after:**
- Adding/removing major dependencies
- Adding new skill directories
- Changing authentication or database provider
- Major refactoring that changes architecture

**Don't run:**
- After every commit
- For minor dependency updates
- When only adding features (not changing stack)

## Related Files

- `CLAUDE.md` - Main project instructions
- `package.json` - Dependencies source of truth
- `.claude/skills/` - Skills directories
- `.env.local.example` - Environment variable template
- `docs/development-progress.yaml` - Current phase (don't duplicate here)
