---
name: engine
description: Claude Code CLI subprocess management - spawning, process pool, session isolation
---

# Engine - Claude Code CLI Subprocess Management

The engine module spawns and manages Claude Code CLI subprocesses as the autonomous agent runtime. This is the core differentiator from OpenClaw (which uses Pi).

## When to Use This Skill

- Modifying how Claude Code subprocesses are spawned
- Changing process pool behavior (concurrency, queuing, timeouts)
- Working with session isolation or project paths
- Debugging subprocess failures or output parsing
- Adding new CLI flags or MCP config injection

## Key Files

- `src/engine/spawn.ts` - Subprocess spawning with session isolation
- `src/engine/pool.ts` - Process pool with FIFO queue (max 4 concurrent)
- `src/engine/types.ts` - Core type definitions (AgentTask, ClaudeSession, ClaudeResult)
- `src/engine/system-prompt.ts` - System prompt builder (main + child prompts)
- `src/engine/subagent-registry.ts` - Subagent run tracking, persistence, orphan reconciliation
- `src/engine/subagent-announce.ts` - Announce pipeline (debounce, retry, nonce-fenced formatting)
- `src/engine/orphan-reaper.ts` - Stale process cleanup at startup

## Architecture

### Spawning Pattern

```
echo "prompt" | claude -p --output-format json --project <session-path>
```

- Prompt is **always piped via stdin** — never CLI args or `--input-file`
- `--output-format json` returns an array of events
- Response extracted with `findLast(e => e.type === "result")`
- Each session gets isolated `--project` path: `~/.openclaude/sessions/<id>/`
- MCP config auto-injected for gateway tools server
- `OPENCLAUDE_SESSION_ID` env var set on MCP subprocess for caller identification
- `CHILD_MODE=true` env var set when session ID starts with `sub-` (restricts MCP tools)
- `CLAUDECODE` env var is **unset** before spawning to avoid nested session errors

### Process Pool

- FIFO queue with configurable max concurrency (default 4, range 1-16)
- `submit(task)` returns `{session, promise}` — queued if at capacity
- `getCompletion(sessionId)` returns a promise that resolves when the session exits (used by announce pipeline's parent-exit guard)
- AbortController-based timeout handling
- `drain()` waits for all tasks to complete
- `stats()` returns running/queued/completed counts

### Session Lifecycle

```
queued → running → completed | failed | killed
```

### Subagent System

Background child sessions spawned via MCP `sessions_spawn` tool. Depth-1 only (no nesting).

- **Registry** (`subagent-registry.ts`): In-memory Map persisted to `~/.openclaude/subagent-runs.json`. Tracks parent-child relationships, lifecycle transitions, result capture with 100KB truncation.
- **Announce pipeline** (`subagent-announce.ts`): When children complete, formats results with nonce-fenced untrusted content delimiters, debounces (2s), acquires per-parent mutex, waits for parent process exit, then resumes parent via router. Retries with exponential backoff (1s→2s→4s).
- **Child prompt** (`system-prompt.ts`): `buildChildSystemPrompt()` produces minimal prompt — no spawn/send tools, memory tools only.
- **Defense in depth**: API rejects spawn from `sub-` prefixed sessions, MCP server omits tools in CHILD_MODE, child prompt instructs against spawning.

## Key Types

```typescript
interface AgentTask {
  sessionId: string;
  prompt: string;
  systemPrompt?: string;
  mcpConfig?: Record<string, {command; args?; env?}>;
  gatewayUrl?: string;
}

interface ClaudeSession {
  id: string;
  projectPath: string;
  pid: number;
  status: "queued" | "running" | "completed" | "failed" | "killed";
  result?: ClaudeResult;
}
```

### Orphan Reaper

`src/engine/orphan-reaper.ts` cleans up stale gateway processes at startup:

- `cleanStaleGatewayProcessesSync(port)` — called in `lifecycle.ts` before binding
- Discovers processes on the gateway port via `lsof -i :port`
- Sends SIGTERM, waits, then SIGKILL if needed
- Polls until port is free before proceeding
- `parsePidsFromLsofOutput()` — pure function for parsing lsof output (testable)

## Critical Rules

- **Never use `--dangerously-skip-permissions`** — it forces API auth mode, breaks Pro subscription
- **Never use `--input-file`** — that flag doesn't exist
- **Never use `--continue`** — sessions are isolated by design
- **Always unset `CLAUDECODE` env var** before spawning
- **Prompt goes to stdin** — never as a CLI argument

## OpenClaw Reference

**Engine is mostly new.** The subagent system adapts patterns from OpenClaw's `src/agents/` (registry types, announce format, cascade kill) but the core spawn/pool is clean-room. OpenClaw uses Pi (a multi-threaded agent runtime), which has no equivalent in OpenClaude. The engine module is a clean-room implementation for Claude Code CLI.

**OpenClaw's agent runtime:** `openclaw-source/src/agents/` — uses Pi spawning, ACP bindings, auth profiles, API key rotation. None of this applies to Claude Code CLI.

**What to reference (sparingly):**
- `openclaw-source/src/agents/agent-scope.ts` — session scoping concepts (adapted for `--project` isolation)
- `openclaw-source/src/agents/agent-paths.ts` — directory structure patterns (adapted for `~/.openclaude/sessions/`)
