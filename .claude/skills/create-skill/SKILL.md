---
name: create-skill
description: Guide for creating new Claude Code skills for the Minds AI webapp. Use when asked to "create a new skill", "add a skill for X", or when documenting a new domain area of the codebase. Covers skill structure, YAML frontmatter format, instruction writing, and skill organization conventions. Do NOT use for OpenClaw agent skills (different format and location).
---

# Create Skill

Skills are markdown files that provide domain-specific knowledge to AI assistants. They load on-demand (unlike CLAUDE.md which always loads), enabling progressive disclosure of detailed information.

## When to Create a Skill

Create a skill when:
- A domain has enough complexity to warrant its own documentation
- You find yourself repeatedly explaining the same patterns
- Code examples and troubleshooting steps would help

Don't create a skill when:
- The information fits in CLAUDE.md (stable, always-needed info)
- The domain is too small (just add it to an existing skill or CLAUDE.md)

## Directory Structure

```
.claude/skills/
└── <skill-name>/
    └── SKILL.md
```

- Use lowercase with hyphens for directory names
- One `SKILL.md` file per skill
- Name should describe the domain or workflow

## File Format

Every skill starts with YAML frontmatter:

```yaml
---
name: skill-name
description: One sentence describing what this skill covers
---
```

Followed by markdown content:

```markdown
# Skill Title

Brief intro explaining the scope.

## Section

Content with examples, patterns, instructions...
```

## Content Guidelines

**Include:**
- Overview of the domain/workflow
- Code examples specific to your project's stack
- Step-by-step instructions for common tasks
- Troubleshooting for known issues
- Links to related files in the codebase

**Avoid:**
- Generic information easily found in official docs
- Duplicating content from CLAUDE.md
- Overly long explanations (be concise)

## Effective Sections

Pick sections that fit your skill's domain:

| Section | Use For |
|---------|---------|
| Overview | What this skill covers, key concepts |
| Patterns | Code patterns with examples |
| Common Tasks | Step-by-step "how to" instructions |
| Configuration | Environment variables, settings |
| Troubleshooting | Common issues and solutions |
| Related Files | Links to relevant code |

## Skill Size

- No strict limit, but aim for focus over breadth
- A skill can be 50 lines or 200 lines depending on complexity
- If a skill grows too large, consider splitting into multiple skills

## Template

Copy this template to create a new skill:

```markdown
---
name: {{skill-name}}
description: {{One sentence description}}
---

# {{Skill Title}}

{{Brief intro paragraph explaining scope.}}

## Overview

{{Key concepts and context.}}

## Patterns

{{Code examples with explanation.}}

\`\`\`{{language}}
// Example code
\`\`\`

## Common Tasks

### {{Task Name}}

1. {{Step 1}}
2. {{Step 2}}
3. {{Step 3}}

## Troubleshooting

### {{Issue}}

**Symptoms:** {{What the user sees}}

**Solution:** {{How to fix it}}

## Related Files

- `{{path/to/file}}` - {{description}}
```

## Referencing Skills

After creating a skill, add it to the skills list in CLAUDE.md so users know it exists:

```markdown
## Skills

Domain-specific knowledge lives in `.claude/skills/`:
- `create-skill/` - How to create new skills
- `your-new-skill/` - Description of your skill
```
