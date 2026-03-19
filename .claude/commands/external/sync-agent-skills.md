---
description: Sync external agent-skills into this repo
argument-hint: [optional skill-name]
---

# Command: Sync Agent Skills

Use add-skill to install/update Vercel agent-skills in this repo.

## Default
Install the current set:
```bash
npx add-skill vercel-labs/agent-skills -a claude-code -s vercel-react-best-practices -s web-design-guidelines -y
```

## Single Skill
When a skill name is provided:
```bash
npx add-skill vercel-labs/agent-skills -a claude-code -s <skill-name> -y
```

## Discover
List available skills:
```bash
npx add-skill vercel-labs/agent-skills --list
```
