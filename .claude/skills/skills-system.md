---
name: skills-system
description: Skill loader, SKILL.md parsing with invocation policies, OpenClaw-style command resolution
---

# Skills System - Auto-Discovery & Command Routing

Loads SKILL.md files from disk, parses YAML frontmatter (including invocation policies), builds command specs, and resolves slash commands using OpenClaw-style resolution. Ported from OpenClaw's `auto-reply/skill-commands.ts` and `agents/skills/workspace.ts`.

## When to Use This Skill

- Adding new skill definitions
- Modifying skill discovery or parsing
- Working with slash command matching
- Debugging skill loading issues
- Adding invocation policies or frontmatter fields

## Key Files

- `src/skills/loader.ts` - Find and parse SKILL.md files, invocation policy resolution
- `src/skills/commands.ts` - Build command specs, resolve invocations, list skills
- `src/skills/index.ts` - Public exports
- `src/skills/loader.test.ts` - Loader tests
- `src/skills/commands.test.ts` - Command resolution tests

## Architecture

### SKILL.md Format

```yaml
---
name: Example Skill
description: What it does
triggers: ["/command1", "/command2"]
user-invocable: true          # default: true — whether /command works
disable-model-invocation: false  # default: false — whether skill appears in system prompt
---
# Markdown content describing the skill (the "body")
```

### Key Types

```typescript
interface SkillInvocationPolicy {
  userInvocable: boolean;          // can users invoke via /command?
  disableModelInvocation: boolean; // hidden from system prompt?
}

interface SkillEntry {
  name: string;
  description: string;
  triggers?: string[];    // slash commands from frontmatter
  body: string;           // markdown content after ---
  path: string;
  invocation: SkillInvocationPolicy;
}

interface SkillCommandSpec {
  name: string;       // sanitised command name (unique)
  skillName: string;  // original skill name from frontmatter
  description: string;
}

interface SkillCommandInvocation {
  command: SkillCommandSpec;
  args?: string;
}
```

### Discovery Flow

```
loadSkills(dir) → glob for SKILL.md files → parse YAML frontmatter → resolve invocation policy → return SkillEntry[]
```

### Command Spec Generation (matches OpenClaw's buildWorkspaceSkillCommandSpecs)

```
buildSkillCommandSpecs(skills, reservedNames?) →
  filter by userInvocable →
  sanitize names (alphanumeric + dashes) →
  deduplicate against reserved names →
  register trigger aliases →
  return SkillCommandSpec[]
```

### Command Resolution (ported from OpenClaw's resolveSkillCommandInvocation)

```
resolveSkillCommandInvocation({text, skillCommands}) →
  /skillname args      → direct skill invocation
  /skill skillname args → explicit meta-command dispatch
  normalised lookup (underscores/spaces → dashes, case-insensitive)
```

### Prompt Construction (OpenClaw parity)

When a skill is invoked, the prompt is rewritten OpenClaw-style:
- **Prompt** (user message): `Use the "skillName" skill for this request.\n\nUser input:\n{args}`
- **System prompt**: Skill body is injected via the skills section of `buildSystemPrompt()` in `src/engine/system-prompt.ts`

This matches how OpenClaw's agent framework separates skill definitions (in system context) from user input (in the message body).

### Skill Locations

- Runtime skills: `~/.openclaude/skills/**/*.md`
- Project skills: `.claude/skills/*.md` (Claude Code native)

## OpenClaw Reference

**Source files ported from:**

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `auto-reply/skill-commands.ts` | `src/skills/commands.ts` | `resolveSkillCommandInvocation`, `findSkillCommand`, normalised lookup |
| `agents/skills/workspace.ts` | `src/skills/commands.ts` | `buildSkillCommandSpecs`, sanitisation, deduplication |
| `agents/skills/frontmatter.ts` | `src/skills/loader.ts` | `resolveInvocationPolicy`, `parseFrontmatterBool` |
| `agents/skills/types.ts` | `src/skills/loader.ts` | `SkillInvocationPolicy`, `SkillCommandSpec` |
| `auto-reply/reply/get-reply-inline-actions.ts` | `src/router/router.ts` | Prompt rewriting pattern |

**What was simplified:**
- No tool dispatch (`command-dispatch: tool`) — all skills go through Claude Code
- No multi-workspace loading or workspace precedence
- No skill filtering per agent
- No OS compatibility checks or install specs
- Triggers are an OpenClaude extension (OpenClaw uses skill name as the command name)
