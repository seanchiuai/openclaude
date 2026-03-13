---
name: config
description: Configuration loading with Zod validation, env var substitution, runtime data paths
---

# Config - Configuration & Paths

Handles loading `config.json`, validating with Zod schemas, substituting environment variables, and providing standard runtime data paths.

## When to Use This Skill

- Adding new configuration options
- Modifying validation schemas
- Working with runtime data paths (~/.openclaude/)
- Debugging config loading or env var substitution issues

## Key Files

- `src/config/loader.ts` - Load config.json with defaults
- `src/config/schema.ts` - Zod validation schemas
- `src/config/paths.ts` - Standard runtime data paths
- `src/config/env-substitution.ts` - `$VAR` → env var replacement
- `src/config/types.ts` - Config type definitions

## Config Structure

```typescript
interface OpenClaudeConfig {
  channels?: {
    telegram?: {enabled, botToken, allowFrom?, mode};
    slack?: {enabled, botToken, appToken, mode, allowFrom?};
  };
  agent: {maxConcurrent (1-16, default 4), defaultTimeout, model?};
  heartbeat?: {enabled, every, target?};
  memory?: {provider, mcpServers?};
  mcp?: Record<string, McpServerConfig>;
}
```

## Runtime Data Paths

```
~/.openclaude/
  ├── config.json           # Main configuration
  ├── gateway.pid           # Running process PID
  ├── HEARTBEAT.md          # Heartbeat checklist
  ├── memory/openclaude.sqlite
  ├── sessions/<id>/prompt.md
  ├── cron/jobs.json
  ├── logs/gateway.log
  └── skills/*.md
```

## Gotchas

- **Empty `allowFrom` array blocks everyone** — omit the field entirely to allow all users
- **Env var substitution runs on ALL config values** — even disabled channels. Don't use `$VAR` for unconfigured channels
- **Zod validates disabled channel tokens** — if a channel block exists, required fields must be valid even if `enabled: false`. Best practice: omit the entire block if not using it

## OpenClaw Reference

**Config was extracted from OpenClaw.** When adding new config options, check the upstream for existing patterns.

**Source:** `openclaw-source/src/config/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `config.ts` | `src/config/loader.ts` | Heavily simplified — removed legacy migration, includes, merge-patch |
| `schema.ts` + `zod-schema.ts` | `src/config/schema.ts` | Simplified — only channels/agent/memory/cron schemas |
| `paths.ts` | `src/config/paths.ts` | Adapted for ~/.openclaude/ |
| `env-substitution.ts` | `src/config/env-substitution.ts` | Direct port |
| `io.ts` | — | File I/O with write-config, snapshots |
| `legacy-migrate.ts` | — | Config format migrations |
| `includes.ts` | — | Config file includes/composition |
| `sessions.ts` | — | Session config management |

**Copy-first workflow:**
1. Find the config pattern in `openclaw-source/src/config/`
2. Copy the relevant Zod schema or loader logic
3. Strip OpenClaw-specific config blocks (discord, whatsapp, signal, iMessage, Pi agent, plugins, etc.)
4. Adapt paths from `~/.openclaw/` to `~/.openclaude/`
5. Rename any "openclaw" references to "openclaude"
