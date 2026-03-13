---
name: skills-system
description: Skill loader, SKILL.md parsing with YAML frontmatter, slash command routing
---

# Skills System - Auto-Discovery & Command Routing

Loads SKILL.md files from disk, parses YAML frontmatter, and routes slash commands. Extracted from OpenClaw.

## When to Use This Skill

- Adding new skill definitions
- Modifying skill discovery or parsing
- Working with slash command matching
- Debugging skill loading issues

## Key Files

- `src/skills/loader.ts` - Find and parse SKILL.md files
- `src/skills/commands.ts` - Match skill commands, list skills
- `src/skills/loader.test.ts` - Loader tests
- `src/skills/commands.test.ts` - Command matching tests

## Architecture

### SKILL.md Format

```yaml
---
name: Example Skill
description: What it does
triggers: ["/command1", "/command2"]
---
# Markdown content describing the skill
```

### SkillEntry Interface

```typescript
interface SkillEntry {
  name: string;
  description: string;
  triggers?: string[];  // slash commands from frontmatter
  body: string;         // markdown content after ---
  path: string;
}
```

### Discovery Flow

```
loadSkills(dir) → glob for SKILL.md files → parse YAML frontmatter → return SkillEntry[]
```

### Command Matching

```
matchSkillCommand(text, skills) → find skill whose trigger matches text prefix → SkillEntry | undefined
```

### Skill Locations

- Runtime skills: `~/.openclaude/skills/*.md`
- Project skills: `.claude/skills/*.md` (Claude Code native)

## OpenClaw Reference

**Skills were extracted from OpenClaw.** The SKILL.md format and discovery pattern are directly ported.

**Source:** `openclaw-source/src/commands/` (skill/command handling)

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `commands.ts` | `src/skills/commands.ts` | Simplified — removed agent commands, plugin auth |
| (in `config/`) | `src/skills/loader.ts` | Skill discovery adapted from config skill loading |

**Copy-first workflow:**
1. Find the command/skill pattern in `openclaw-source/src/commands/`
2. Copy the parsing or matching logic
3. Strip multi-agent, plugin, and auth-related command handling
4. Adapt to OpenClaude's simpler SkillEntry interface
5. Rename any "openclaw" references to "openclaude"
