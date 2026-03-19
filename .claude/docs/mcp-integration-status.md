# MCP Integration Status

Last updated: 2026-03-18

## ChatGPT Integration

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | StreamableHTTP transport (`/mcp`) | Done | `server/routes/mcp.ts` |
| 2 | OAuth 2.1 + PKCE (S256) | Done | `server/routes/oauth/` |
| 3 | Dynamic Client Registration | Done | `POST /oauth/register` |
| 4 | `/.well-known/oauth-authorization-server` | Done | Discovery endpoint |
| 5 | `/.well-known/oauth-protected-resource` | Done | Resource metadata |
| 6 | CORS for `chatgpt.com` / `openai.com` | Done | In `config.ts` |
| 7 | Fix OAuth `state` round-trip | Fixed (not deployed) | Schema + 3 file changes, migration `add_oauth_state_field` |
| 8 | Deploy `state` fix + run migration | TODO | Needs PR → staging → production |
| 9 | Test full OAuth flow end-to-end | TODO | Verify popup closes, tools work |
| 10 | Register as ChatGPT Connector | TODO | Settings → Connectors → Create in ChatGPT |

## Claude (Desktop + Web)

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | stdio transport | Done | `server/mcp/stdio.ts` |
| 2 | Remote URL connector (StreamableHTTP) | Done | Same `/mcp` endpoint as ChatGPT |
| 3 | API key auth | Done | `minds_*` Bearer token |
| 4 | OAuth (optional, for web connector) | Done | Same OAuth flow |
| 5 | Test remote URL connector | TODO | Paste `https://getminds.ai/mcp` in Claude UI |
| 6 | Desktop Extension bundle (`.mcpb`) | Optional | One-click install packaging |

## Cursor / VS Code / Other stdio Clients

| # | Task | Status | Notes |
|---|------|--------|-------|
| 1 | stdio transport | Done | Same `stdio.ts` |
| 2 | API key auth via env var | Done | `MINDSAI_API_KEY` |
| 3 | Test in Cursor | TODO | Add to Cursor MCP config, verify tools |
| 4 | Test in VS Code (Copilot) | TODO | Verify compatibility |

## Feature Support Matrix

| Feature | ChatGPT | Claude Desktop | Claude Web | Cursor | Other stdio |
|---------|---------|---------------|------------|--------|-------------|
| StreamableHTTP (`/mcp`) | Required | Supported | Required | No | No |
| stdio transport | No | Supported | No | Required | Required |
| OAuth 2.1 + PKCE | Required | Optional | Optional | No | No |
| Dynamic Client Registration | Required | No | No | No | No |
| `/.well-known/oauth-*` | Required | No | No | No | No |
| API key auth (Bearer) | Fallback | Yes (env var) | Yes | Yes (env var) | Yes (env var) |
| `state` param round-trip | Required | N/A | N/A | N/A | N/A |
| CORS headers | Required | N/A | Required | N/A | N/A |

## Available MCP Tools

| Tool | Auth Required | Description |
|------|--------------|-------------|
| `list_my_ai_personas` | Yes | List user's sparks with fuzzy search |
| `create_ai_persona_or_digital_twin` | No (demo) | Create spark via clone/keywords/link |
| `talk_to_ai_persona` | Yes | Chat with a spark |
| `check_ai_persona_training_progress` | Yes | Poll creation status |
| `create_panel` | Yes | Create survey panel with spark groups |
| `ask_panel` | Yes | Ask all panel groups a question |
| `export_panel` | Yes | Export survey results |

## Key Files

- `server/routes/mcp.ts` — HTTP transport handler
- `server/mcp/server.ts` — MCP server factory, tool/resource registration
- `server/mcp/stdio.ts` — stdio transport entry point
- `server/mcp/config.ts` — CORS, rate limits, cache TTLs
- `server/mcp/tools/*.ts` — Tool implementations
- `server/routes/oauth/*.ts` — OAuth endpoints
- `server/routes/.well-known/*.ts` — Discovery endpoints

## OAuth Bug Fix (2026-03-18)

**Problem:** ChatGPT sends a `state` parameter during OAuth for CSRF protection. The server wasn't saving it to the DB, so the redirect back to ChatGPT was missing `state`, causing ChatGPT to reject the callback.

**Fix (4 changes):**
1. `prisma/schema.prisma` — Added `state String?` to `OAuthAuthorizationCode`
2. `server/routes/oauth/authorize.get.ts` — Save `state` in temp record creation
3. `server/api/oauth/complete.post.ts` — Include `state` in redirect URL
4. `prisma/migrations/add_oauth_state_field/migration.sql` — ALTER TABLE

**Status:** Fixed locally, not yet deployed. Needs PR to staging.
