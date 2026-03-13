---
name: router
description: Fixed static dispatch table with OpenClaw-style skill resolution, session management, and memory injection
---

# Router - Static Message Dispatch

Routes inbound messages and commands to appropriate handlers using a fixed dispatch table — no LLM-based orchestration. Skill resolution follows OpenClaw's `resolveSkillCommandInvocation` pattern.

## When to Use This Skill

- Adding new gateway commands
- Modifying message routing logic
- Working with session management (main vs isolated)
- Changing skill command routing or prompt construction
- Debugging memory context injection

## Key Files

- `src/router/router.ts` - Main routing logic, skill dispatch, session management
- `src/router/commands.ts` - Gateway command handlers
- `src/router/types.ts` - Route types (ChatSession, ParsedCommand)
- `src/router/router.test.ts` - Tests
- `src/engine/system-prompt.ts` - System prompt builder (skills section, memory, tools)

## Architecture

### Dispatch Flow (first match wins)

1. `/reset` → clear session for calling chat
2. Gateway commands (`/help`, `/list`, `/status`, `/skills`, `/memory`, `/cron`) → direct response, no spawn
3. Skill triggers → OpenClaw-style prompt rewrite, spawn Claude Code
4. Cron jobs (`source === "cron"`) → isolated session each time
5. User messages → main session with `--resume`, memory context on first message

### Skill Dispatch (OpenClaw parity)

```typescript
// 1. Build command specs at router creation
const skillCommands = buildSkillCommandSpecs(skills, GATEWAY_COMMANDS);

// 2. Resolve invocation (supports /skillname and /skill skillname)
const invocation = resolveSkillCommandInvocation({
  commandBodyNormalized: message.text,
  skillCommands,
});

// 3. OpenClaw-style prompt construction
const prompt = [
  `Use the "${invocation.command.skillName}" skill for this request.`,
  invocation.args ? `User input:\n${invocation.args}` : null,
].filter(Boolean).join("\n\n");

// 4. Skill body is injected via system prompt (skills section in buildSystemPrompt)
```

### Session Management

```typescript
interface ChatSession {
  sessionId: string;            // Internal ID for pool (e.g. "main-abc123")
  claudeSessionId: string;      // UUID for Claude Code --session-id/--resume
  lastMessageAt: number;        // For idle reset (4h threshold)
  messageCount: number;         // 0 = first (--session-id), 1+ = --resume
  totalInputTokens?: number;    // Accumulated input tokens (for memory flush)
  totalOutputTokens?: number;   // Accumulated output tokens
  compactionCount?: number;     // Auto-compaction count
  lastFlushCompactionCount?: number; // Compaction count at last memory flush
}
```

### Pre-Turn Memory Flush

Before dispatching user messages, the router calls `shouldFlushMemory(session)` from `src/memory/memory-flush.ts`. If true, it runs `flushSessionToMemory()` to preserve durable facts before context compaction. This ensures long-running sessions don't lose important context.

- Session key: `{channel}:{chatId}` (stable per chat)
- Persisted to `~/.openclaude/sessions-map.json`
- Auto-reset after 4 hours idle
- First message: `--session-id`, system prompt with memory + skills
- Subsequent: `--resume`, no system prompt

### System Prompt (first message only)

Built by `buildSystemPrompt()` in `src/engine/system-prompt.ts`. Includes:
- Skills section (full skill bodies, filtered by `disableModelInvocation`)
- Memory context (from search results)
- Gateway tools reference (if MCP available)
- Reply tags, messaging rules, safety, heartbeat

## OpenClaw Reference

**Router diverges architecturally from OpenClaw** (static dispatch vs LLM orchestration), but **skill dispatch now matches OpenClaw's pattern**.

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `auto-reply/skill-commands.ts` | `src/skills/commands.ts` | `resolveSkillCommandInvocation` ported directly |
| `auto-reply/reply/get-reply-inline-actions.ts` | `src/router/router.ts` | Prompt rewriting pattern (model dispatch path) |
| `routing/resolve-route.ts` | — | LLM-based route resolution (NOT used) |

**When to copy from OpenClaw:** For skill resolution patterns, prompt construction, or session key utilities. Do NOT copy the LLM orchestrator — static dispatch is intentional.
