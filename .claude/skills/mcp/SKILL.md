---
name: mcp
description: Model Context Protocol server exposing gateway tools to Claude Code subprocesses
---

# MCP - Gateway Tools Server

Standalone MCP server subprocess that exposes gateway tools (memory, cron, send) to Claude Code sessions via the Model Context Protocol.

## When to Use This Skill

- Adding new MCP tools
- Modifying MCP server behavior
- Debugging tool availability in Claude sessions
- Working with MCP config injection in the engine

## Key Files

- `src/mcp/gateway-tools-server.ts` - Standalone MCP server subprocess
- `src/mcp/index.ts` - Entry point

## Architecture

### How It Works

```
Engine spawns Claude CLI
  → injects MCP config (.mcp.json in session dir)
  → Claude starts MCP server as subprocess
  → MCP server connects to gateway via HTTP
  → Claude can call tools: cron_add, memory_search, send_message, etc.
```

### Communication

- **Claude ↔ MCP server**: stdio (MCP protocol)
- **MCP server ↔ Gateway**: HTTP requests to `GATEWAY_URL` (port 45557)

### Exposed Tools

Same as gateway HTTP API endpoints:
- `cron_add`, `cron_list`, `cron_remove`, `cron_run`, `cron_status`
- `memory_search`, `memory_get`
- `logs_tail`
- `send_message` *(parent-only — hidden in CHILD_MODE)*
- `sessions_spawn` *(parent-only — spawn background subagent)*
- `sessions_status` *(parent-only — check subagent status)*

### CHILD_MODE

When `CHILD_MODE=true` env var is set (auto-set for `sub-*` sessions by `spawn.ts`), the MCP server omits `send_message`, `sessions_spawn`, and `sessions_status`. This enforces tool restrictions at infrastructure level for child sessions.

### Config Injection

The engine (`spawn.ts`) writes `.mcp.json` to each session's project directory:
```json
{
  "mcpServers": {
    "gateway-tools": {
      "command": "node",
      "args": ["path/to/gateway-tools-server.js"],
      "env": {"GATEWAY_URL": "http://localhost:45557"}
    }
  }
}
```

## OpenClaw Reference

**MCP is entirely new — no OpenClaw equivalent.** OpenClaw exposes tools through its WebSocket protocol, not MCP. The MCP gateway tools server is a clean-room implementation specific to Claude Code's tool integration.

**What to reference (for tool definitions only):**
- `openclaw-source/src/gateway/server-cron.ts` — cron tool API shapes
- `openclaw-source/src/gateway/server-methods/` — memory/send tool API shapes
