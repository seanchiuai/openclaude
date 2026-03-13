---
name: router
description: Fixed static dispatch table for routing messages and commands without LLM orchestration
---

# Router - Static Message Dispatch

Routes inbound messages and commands to appropriate handlers using a fixed dispatch table — no LLM-based orchestration.

## When to Use This Skill

- Adding new gateway commands
- Modifying message routing logic
- Working with session management (main vs isolated)
- Adding skill command routing

## Key Files

- `src/router/router.ts` - Main routing logic
- `src/router/commands.ts` - Gateway command handlers
- `src/router/types.ts` - Route types
- `src/router/router.test.ts` - Tests

## Architecture

### Route Actions

```typescript
type RouteAction =
  | {type: "gateway_command"; command: ParsedCommand}
  | {type: "main_session"; message: InboundMessage}
  | {type: "isolated_session"; prompt: string}
```

### Dispatch Flow

1. Check for slash commands → match against skills
2. Check for gateway commands (cron_add, memory_search, send_message, etc.)
3. Default: route to **main session** (stable per chatId for context retention)
4. Cron jobs → **isolated sessions** (separate Claude process)

### Gateway Commands

Built-in commands: `cron_add`, `cron_list`, `cron_remove`, `memory_search`, `memory_get`, `send_message`

### Key Pattern

- Main session ID is stable per chatId — preserves context across conversation turns
- Memory context is automatically injected into system prompt for main sessions
- Skills are matched by slash command prefix from frontmatter triggers

## OpenClaw Reference

**Router diverges significantly from OpenClaw.** OpenClaw uses LLM-based orchestration (`openclaw-source/src/routing/`); OpenClaude uses a fixed static dispatch table. Only copy from OpenClaw for specific utilities.

**Source:** `openclaw-source/src/routing/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `session-key.ts` | (inline in router.ts) | Session ID generation logic |
| `resolve-route.ts` | — | LLM-based route resolution (NOT used) |
| `account-lookup.ts` | — | Multi-account routing (NOT used) |

**When to copy:** Only for session key generation or account ID utilities. Do NOT copy the LLM orchestrator — OpenClaude's static dispatch is an intentional architectural decision.
