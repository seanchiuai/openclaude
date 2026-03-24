---
description: View or update agent identity — name, vibe, persona, user profile
---

# Identity

View or update the agent's identity and user profile files.

## Files

| File | What it contains |
|------|-----------------|
| `workspace/IDENTITY.md` | Name, creature type, vibe, emoji, avatar |
| `workspace/SOUL.md` | Persona, tone, values, boundaries |
| `workspace/USER.md` | Human's name, timezone, preferences |
| `workspace/TOOLS.md` | Local environment (SSH hosts, devices, services) |

## Commands

Parse the user's request to determine the action:

### "who am I" / "show identity" / "what's my name"

1. Read `workspace/IDENTITY.md`
2. Present the current identity: name, creature, vibe, emoji

### "change my name to X" / "update my vibe" / "new emoji"

1. Read `workspace/IDENTITY.md`
2. Update the requested field
3. Show the updated identity
4. `retain` the change to Hindsight: "Agent identity updated: [field] changed to [value]"

### "update soul" / "change persona" / "update values"

1. Read `workspace/SOUL.md`
2. Discuss the change with the user — SOUL.md is personal, don't just overwrite
3. After agreement, update the relevant section
4. `retain` the change to Hindsight

### "update user profile" / "my timezone is X" / "call me X"

1. Read `workspace/USER.md`
2. Update the requested field
3. `retain` the change to Hindsight

### "update tools" / "add SSH host X" / "my camera is X"

1. Read `workspace/TOOLS.md`
2. Add or update the environment-specific note
3. `retain` the change to Hindsight

## Notes

- Always show the user what changed before and after
- SOUL.md changes should be conversational, not mechanical
- `retain` all identity changes so Hindsight tracks the history
