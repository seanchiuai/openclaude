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

1. **Header + Description** - Project purpose (line 1-3)
2. **Commands** - npm/npx commands
3. **Ralph Loop Workflow** - Development process
4. **Environment Variables** - Env var names (not values)
5. **Boundaries** - Development rules

### Variable Sections (update when codebase changes)

1. **Tech Stack** - Update when:
   - New framework/library added to package.json
   - Major dependency replaced (e.g., switched from Anthropic to Vertex)
   - New integration added (auth, DB, etc.)

2. **Development Phases** - Update when:
   - Phase structure changes
   - User story mapping changes
   - Note: Don't update "current phase" - that's in `development-progress.yaml`

3. **Skills list** - Update when:
   - New skill directory added to `.claude/skills/`
   - Skill removed or renamed

## Update Process

### Step 1: Gather Current State

```bash
# Check package.json for dependencies
cat package.json | jq '.dependencies, .devDependencies'

# List current skills
ls .claude/skills/

# Check for new env vars in use
grep -r "process.env" --include="*.ts" --include="*.tsx" | grep -v node_modules
```

### Step 2: Compare Against CLAUDE.md

For each variable section:
1. Read current CLAUDE.md section
2. Compare against codebase reality
3. Identify discrepancies only

### Step 3: Update Only Discrepancies

**Tech Stack updates:**
- Add new items at end of list
- Remove items no longer in package.json
- Update descriptions if technology changed (e.g., "Anthropic" → "Vertex AI")

**Skills list updates:**
- Alphabetize skill directories
- Add new directories found
- Remove directories no longer present

**Do NOT change:**
- Formatting/indentation
- Section ordering
- Wording of constant sections
- Line breaks or spacing

## Validation Checks

Before updating, verify:

### Tech Stack
```
For each item in CLAUDE.md Tech Stack:
  - Is it still in package.json?
  - Is the description accurate?
  - Is it still being used (imports exist)?
```

### Skills
```
For each skill listed:
  - Does .claude/skills/<name>/ exist?
  - Does it have SKILL.md?
```

### Environment Variables
```
For each env var listed:
  - Is it referenced in code or .env.local.example?
  - Is description accurate?
```

## Output Format

```markdown
## CLAUDE.md Sync Report

### Tech Stack
- ✓ Next.js 14 - verified
- ✓ Convex - verified
- ⚠️ Updated: "Anthropic SDK" → "Vercel AI SDK + @ai-sdk/google-vertex"
- 🆕 Added: "agent-browser (E2E testing)"

### Skills
- ✓ 9 skills verified
- ✓ All directories exist

### Environment Variables
- ✓ All vars documented
- 🆕 Added: GOOGLE_VERTEX_PROJECT, GOOGLE_CLIENT_EMAIL

### Changes Made
- Updated Tech Stack line 10
- Added 2 env vars

✅ CLAUDE.md updated (or "No changes needed")
```

## Example: Detecting Tech Stack Changes

**package.json has:**
```json
{
  "@ai-sdk/google-vertex": "^1.0.0",
  "@clerk/nextjs": "^5.0.0",
  "convex": "^1.0.0"
}
```

**CLAUDE.md says:**
```
- Anthropic SDK (Claude API)
- Clerk (authentication)
```

**Action:**
- Update "Anthropic SDK" → "Vercel AI SDK + @ai-sdk/google-vertex (Gemini)"
- Keep "Clerk" unchanged

## What NOT to Update

1. **Current phase reference** - Points to `development-progress.yaml`
2. **Specific file paths in examples** - Unless files moved
3. **The Boundaries section** - These are project rules
4. **Ralph Loop Workflow** - This is process, not state

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
