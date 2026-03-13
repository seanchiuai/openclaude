---
description: Sync skill expertise with current codebase changes
argument-hint: [skill-name or "all"]
---

# Command: Sync Skills

Update skill documentation and project docs to reflect current codebase state. **Only update files when actual discrepancies are found** - don't make changes for the sake of changes.

## Usage

```bash
/sync-skills <skill-name>        # Sync a specific skill
/sync-skills docs                # Sync PRD.md, TASKS.md, design.md
/sync-skills all                 # Sync all skills + docs
```

## Key Principle: Update Only When Necessary

Before editing any file, verify there's an actual discrepancy:
- Compare docs against codebase state
- If already in sync, report "No changes needed" and skip
- Don't make cosmetic or formatting-only changes
- Don't update timestamps or version numbers without substantive changes

## Skills Location

Skills are located in `.claude/skills/`. Each skill directory contains:
- `SKILL.md` - Overview and when to use (required)
- `reference.md` - Code patterns and examples (optional)

To discover available skills, list the directories in `.claude/skills/`.

## What Gets Synced

### Skill Files (SKILL.md + reference.md)

**Only update if discrepancies found** - skip files already in sync.

1. **SKILL.md** - Overview and when to use
   - Validate "Where It's Used" sections match actual code
   - Update phase mappings only if code moved
   - Check import paths still exist

2. **reference.md** - Code patterns and examples
   - Validate code snippets match actual implementations
   - Update file paths only if files moved
   - Add new patterns only if discovered 3+ times in codebase
   - Remove patterns only if no longer used anywhere

### Project Docs (PRD.md, TASKS.md, design.md)

**Only update if discrepancies found** - skip files already in sync.

1. **docs/PRD.md** - Product requirements
   - Update acceptance criteria checkboxes based on implemented features
   - Mark `[x]` for criteria that pass (code exists, tests pass)
   - Keep `[ ]` for criteria not yet implemented

2. **TASKS.md** - Task tracking
   - Move completed tasks to "Complete" section
   - Move in-progress tasks to "Active" section
   - Update phase task groupings
   - Remove duplicate or stale tasks

3. **docs/design.md** - UI/UX specifications
   - Validate component specs match actual implementations
   - Update color values, spacing, typography if changed
   - Add new component specs for implemented features
   - Remove specs for deprecated/removed components

## Sync Process

### For Individual Skill

```bash
/sync-skills <skill-name>
```

**Process:**
1. Read `.claude/skills/<skill-name>/SKILL.md`
2. Read `.claude/skills/<skill-name>/reference.md` (if exists)
3. Explore relevant codebase directories based on skill domain
4. Validate:
   - Code examples in reference.md match actual files
   - Import paths exist
   - File paths in "Where It's Used" sections are accurate
5. **Only if discrepancies found:**
   - Fix outdated paths
   - Add new patterns (3+ occurrences)
   - Remove patterns no longer in use
   - Update phase descriptions if needed
6. Report which files updated vs unchanged

### For Docs Only

```bash
/sync-skills docs
```

**Process:**
1. Read `docs/PRD.md`, `TASKS.md`, `docs/design.md`
2. Compare against current codebase state
3. For each acceptance criterion in PRD.md:
   - Check if feature exists in codebase
   - Run typecheck for "Typecheck passes" criteria
   - Check browser if "Verify in browser" criteria
   - Update checkbox only if state changed: `[ ]` -> `[x]` or vice versa
4. For TASKS.md:
   - Match tasks to completed criteria
   - Move tasks between Active/Backlog/Complete only if needed
5. For design.md:
   - Validate UI specs match actual component implementations
   - Update only if specs are out of sync with code
6. **Skip files with no changes** - report "already in sync"

### For All

```bash
/sync-skills all
```

**Process:**
1. Discover all skills in `.claude/skills/`
2. Sync each skill - only update if discrepancies found
3. Sync docs (PRD.md, TASKS.md, design.md) - only update if discrepancies found
4. Show aggregate summary with list of files changed vs skipped

## Validation Rules

### Skill Files

**Update reference.md when:**
- Code example is outdated (file changed)
- Import path no longer exists
- New pattern found 3+ times in codebase
- Pattern no longer used anywhere

**Update SKILL.md when:**
- "Where It's Used" phase info is wrong
- New integration added to project
- Section describes removed feature

### PRD.md Criteria

**Mark `[x]` when:**
- Feature code exists and works
- Typecheck passes (for typecheck criteria)
- Visual verification passes (for browser criteria)

**Keep `[ ]` when:**
- Feature not implemented
- Tests failing
- Code exists but incomplete

### TASKS.md

**Move to "Active" when:**
- Currently being worked on

**Move to "Complete" when:**
- All acceptance criteria marked `[x]` in PRD.md
- Code committed and working

**Keep in "Backlog" when:**
- Not started
- Dependencies not met

### design.md

**Update component spec when:**
- Actual component differs from spec (colors, spacing, etc.)
- New component implemented but not documented
- Component removed from codebase

**Keep unchanged when:**
- Spec matches implementation
- Component not yet implemented (spec is aspirational)

## Example Output

```markdown
## Syncing <skill-name>...

### Files Checked
- <relevant-file-1> ✓
- <relevant-file-2> ✓

### reference.md
- ✅ Code snippet validated (matches actual file)
- ⚠️  Updated import path: old → new
- 🆕 Added: new pattern (found in 4 files)

### SKILL.md
- ✓ No changes needed - already in sync

✅ <skill-name>: reference.md updated, SKILL.md unchanged

---

## Syncing docs...

### PRD.md
- US-XXX: [x] Feature implemented (path/to/file.tsx)
- US-XXX: [ ] Feature - NOT IMPLEMENTED
→ N checkboxes updated

### TASKS.md
- Moved to Complete: "Task name"
- Kept in Backlog: Phase N tasks
→ N tasks moved

### design.md
- ✓ No changes needed - specs match implementations

✅ docs: PRD.md updated, TASKS.md updated, design.md unchanged
```

## Sync State Tracking

Sync state is stored in `.claude/sync-skills.local.md` (gitignored). This file tracks when skills/docs were last synced.

**Format:**
```yaml
---
last_sync_commit: abc123def
last_sync_date: 2026-01-27T10:30:00Z
synced_items:
  - clerk-auth
  - convex-patterns
  - docs
---
# Sync Notes
Optional notes about sync state...
```

**Workflow:**
1. Before sync: Read `.claude/sync-skills.local.md` to get `last_sync_commit`
2. Run `git diff <last_sync_commit>..HEAD --name-only` to find changed files
3. Only sync skills/docs affected by changed files
4. After sync: Update `last_sync_commit` to current HEAD

**If no tracking file exists:** Treat as first sync - check everything.

## When to Run

**Run sync after:**
- Completing a user story
- Finishing a development phase
- Major refactoring
- Finding outdated skill info

**Don't run:**
- During active development (wait for stable)
- When build is broken
- After every commit (too frequent)

## Related Files

- `docs/PRD.md` - Product requirements with acceptance criteria
- `TASKS.md` - Task tracking by phase
- `docs/design.md` - UI/UX specifications
- `docs/development-progress.yaml` - Phase status (don't edit without permission)
- `.claude/skills/*/SKILL.md` - Skill overviews
- `.claude/skills/*/reference.md` - Code patterns
- `.claude/sync-skills.local.md` - Sync state tracking (gitignored)

## Troubleshooting

### Skill not found

```
Skill '<name>' not found.
Available skills are directories in .claude/skills/
```

**Solution:** List `.claude/skills/` to see available skill names

### No changes detected

```
⚠️ No updates needed - skill already in sync
```

**Reason:** Codebase matches documentation
**Action:** This is normal and good!

### Conflicting acceptance criteria

```
⚠️ US-XXX criterion "Feature description" - Found code but not working
```

**Solution:** Investigate - may be bug or incomplete implementation
