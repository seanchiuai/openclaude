---
name: gateway
description: Node.js HTTP daemon lifecycle, Hono endpoints, launchd integration, subsystem orchestration
---

# Gateway - HTTP Daemon & Lifecycle

The gateway is the main entry point that orchestrates all subsystems: config loading, process pool, channels, memory, cron, and the HTTP server.

## When to Use This Skill

- Modifying startup/shutdown sequence
- Adding or changing HTTP endpoints
- Working with the launchd integration (macOS)
- Debugging daemon lifecycle issues
- Adding new subsystems to the boot sequence

## Key Files

- `src/gateway/lifecycle.ts` - Startup/shutdown orchestration
- `src/gateway/http.ts` - Hono HTTP endpoints
- `src/gateway/launchd.ts` - macOS LaunchAgent install/uninstall
- `src/gateway/lifecycle.test.ts` - Integration tests
- `src/logging/logger.ts` - Structured JSON logger used across all subsystems
- `src/logging/diagnostic.ts` - Diagnostic heartbeat for infrastructure monitoring

## Architecture

### Boot Sequence

```
startGateway(configPath?)
  → cleanStaleGatewayProcessesSync(port)  // orphan reaper
  → loadConfig()
  → createProcessPool()
  → initChannels() (Telegram, Slack)
  → createMemoryManager()
  → createSubagentRegistry() + reconcileOrphans()
  → createCronService()
  → createAnnouncePipeline()
  → startHttpServer() (port 45557)
```

### Structured Logging

All subsystems use `src/logging/logger.ts` — a structured JSON logger:

- **Log file**: `~/.openclaude/logs/gateway.log` (JSON lines)
- **Stderr**: colored human-readable output
- **Log levels**: fatal, error, warn, info, debug, trace
- **Config**: `OPENCLAUDE_LOG_LEVEL` env var (default: info)
- **Child loggers**: `createLogger("subsystem")` for hierarchical logging
- Used by: gateway, channels, config, cron, engine, memory, skills

### HTTP Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Liveness check |
| `/ready` | GET | Readiness check |
| `/api/status` | GET | Uptime, channels, pool stats |
| `/api/cron/*` | GET/POST/DELETE | Cron job management |
| `/api/memory/*` | GET/POST | Memory search/read |
| `/api/send` | POST | Send message to a channel |
| `/api/logs/tail` | GET/POST | Read recent gateway log lines |
| `/api/subagent/spawn` | POST | Spawn a background child session |
| `/api/subagent/status` | POST | Check status of spawned children |

### Lifecycle

- PID file at `~/.openclaude/gateway.pid`
- Graceful shutdown via SIGTERM signal handling
- Drains process pool, stops channels, closes DB connections

### Gateway Interface

```typescript
interface Gateway {
  config: OpenClaudeConfig;
  pool: ProcessPool;
  channels: Map<string, ChannelAdapter>;
  memoryManager?: MemoryManager;
  cronService?: CronService;
  subagentRegistry?: SubagentRegistry;
  shutdown: () => Promise<void>;
}
```

## Critical Rules

- Port 45557 is fixed — check for conflicts before starting
- Only one gateway instance per machine (PID file enforced)
- Check `launchctl list | grep openclaude` and `lsof -i :45557` before starting

## OpenClaw Reference

**Gateway was adapted from OpenClaw but significantly simplified.** OpenClaw's gateway is a full WebSocket server with auth, control UI, plugin system, and multi-agent management. OpenClaude's gateway is a simple HTTP daemon.

**Source:** `openclaw-source/src/gateway/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `boot.ts` | `src/gateway/lifecycle.ts` | Heavily simplified — removed auth, plugins, WebSocket |
| `server-http.ts` | `src/gateway/http.ts` | Simplified to Hono endpoints only |
| (in `daemon/`) | `src/gateway/launchd.ts` | macOS-specific, new implementation |
| `server.ts` | — | Full WebSocket server (NOT used) |
| `auth.ts` | — | Auth system (NOT used) |
| `control-ui.ts` | — | Web control panel (NOT used) |

**Copy-first workflow:**
1. Find the feature in `openclaw-source/src/gateway/`
2. Copy only HTTP endpoint patterns or boot sequence logic
3. Strip WebSocket, auth, control UI, plugin, and multi-agent code
4. Adapt to Hono framework (OpenClaw uses its own HTTP layer)
5. Rename any "openclaw" references to "openclaude"
