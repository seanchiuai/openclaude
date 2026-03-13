---
name: tools
description: Agent tools exposed via MCP - memory search, send message, file operations
---

# Tools - Agent Tool Functions

Tool functions injected into Claude sessions via MCP for memory access, messaging, and file operations.

## When to Use This Skill

- Adding new tools for Claude sessions
- Modifying existing tool behavior
- Working with the MCP gateway tools server
- Debugging tool availability in spawned sessions

## Key Files

- `src/tools/memory-tools.ts` - memory_search, memory_get
- `src/tools/send-tool.ts` - send_message
- `src/tools/file-tools.ts` - File I/O operations
- `src/mcp/gateway-tools-server.ts` - MCP server subprocess exposing tools

## Architecture

### Available Tools

| Tool | Purpose |
|------|---------|
| `memory_search` | Hybrid search across memory files |
| `memory_get` | Read specific memory file content |
| `send_message` | Send message to a channel (Telegram/Slack) |
| `read_file` | Read file contents |
| `write_file` | Write file contents |
| `list_dir` | List directory contents |

### MCP Integration

Tools are exposed via an MCP server subprocess that communicates with the gateway over HTTP:

```
Claude session ←stdio→ MCP server ←HTTP→ Gateway (port 45557)
```

- MCP config is auto-injected by `engine/spawn.ts` when `gatewayUrl` is set
- The MCP server is spawned as a child process alongside Claude
- Gateway URL passed via `GATEWAY_URL` env var

### Tool Interfaces

```typescript
// Memory tools
memory_search(params: {query, maxResults?, minScore?}): Promise<MemorySearchResult[]>
memory_get(params: {path, from?, lines?}): Promise<{text}>

// Send tool
send_message(params: {channel, chatId, text, parseMode?}): Promise<SendResult>
```

## OpenClaw Reference

**Tools are simplified versions of OpenClaw's gateway methods.** OpenClaw exposes tools through its WebSocket protocol; OpenClaude exposes them through an MCP server over HTTP.

**Source:** `openclaw-source/src/gateway/server-methods/` and `openclaw-source/src/gateway/tools-invoke-http.ts`

**Copy-first workflow:**
1. Find the tool's gateway method in `openclaw-source/src/gateway/server-methods/` or `server-cron.ts`
2. Copy the handler logic
3. Strip WebSocket protocol, auth checks, and multi-agent context
4. Wrap as an MCP tool or HTTP endpoint handler
5. Rename any "openclaw" references to "openclaude"
