---
name: mcp
description: Model Context Protocol (MCP) server for external AI clients. Use when working on MCP tools, resources, OAuth integration, adding new tools, debugging MCP protocol issues, or configuring ChatGPT/Claude Desktop/Cursor integrations. Covers HTTP and stdio transports, rate limiting, circuit breakers, and tool implementations. Do NOT use for general API routes (use api-server skill) or authentication flows outside MCP (use auth skill).
---

# MCP Server

Model Context Protocol server enabling external AI clients (ChatGPT, Claude Desktop, Cursor) to interact with Minds AI. Supports creating AI personas, chatting with them, and running panel surveys through a standardized protocol.

## Architecture

```
External Clients:
  ChatGPT Apps ---> HTTPS /mcp (StreamableHTTP transport)
  Claude Desktop --> stdio (StdioServerTransport)
  Cursor ----------> stdio (StdioServerTransport)
  MCP Inspector --> HTTPS /mcp (for testing)

                    +------------------------------------------+
                    |           MCP Server Module              |
                    |   server/mcp/                            |
                    |                                          |
HTTP Transport:     |   server.ts -----> createMindsServer()   |
  server/routes/    |        |                                 |
  mcp.ts ---------->|        +---> Tools (listSparks, etc.)    |
                    |        +---> Resources (sparkWidget)     |
                    |                                          |
stdio Transport:    |   stdio.ts -----> createStdioServer()    |
  npx tsx ---------->|        |                                 |
  server/mcp/       |        +---> Same tools/resources        |
  stdio.ts          |                                          |
                    +------------------------------------------+
                              |
                              v
                    Internal API (localhost:3000/api/v1/*)
```

## Transports

### HTTP Transport (ChatGPT, Web Clients)

Route handler at `server/routes/mcp.ts` using `StreamableHTTPServerTransport`:

- **Endpoint**: `/mcp` (stateless mode, no session ID required)
- **Auth**: Bearer token (OAuth or API key `minds_*`/`aox_*`)
- **Health check**: `GET /mcp` returns server status, circuit breaker states, metrics
- **Protocol**: JSON-RPC 2.0 over HTTP POST

### stdio Transport (Claude Desktop, Cursor)

Standalone process at `server/mcp/stdio.ts` using `StdioServerTransport`:

```json
// Claude Desktop config (claude_desktop_config.json)
{
  "mcpServers": {
    "mindsai": {
      "command": "npx",
      "args": ["tsx", "/path/to/webapp/server/mcp/stdio.ts"],
      "env": {
        "MINDSAI_API_KEY": "minds_your_api_key_here"
      }
    }
  }
}
```

## Authentication

### OAuth 2.1 + PKCE (ChatGPT)

OAuth flow for ChatGPT connector:

1. **Discovery**: `/.well-known/oauth-authorization-server` returns OAuth metadata
2. **Authorize**: `/oauth/authorize` validates PKCE params, initiates Supabase Google login
3. **Callback**: `/oauth/callback` exchanges Supabase session for authorization code
4. **Token**: `/oauth/token` exchanges authorization code for access token
5. **Registration**: `/oauth/register` for dynamic client registration (ChatGPT Apps SDK)

Key files:
- `server/routes/oauth/authorize.get.ts` - Authorization endpoint
- `server/routes/oauth/callback.get.ts` - Post-login callback
- `server/routes/oauth/token.post.ts` - Token exchange
- `server/routes/.well-known/oauth-authorization-server.get.ts` - OAuth metadata

### API Key Auth

Direct API key authentication (`minds_*` or legacy `aox_*` prefix):

```bash
# Header format
Authorization: Bearer minds_your_api_key_here
```

### Public Tools

Some tools work without authentication (for demos):
- `create_ai_persona_or_digital_twin` - Create sparks without auth

## Tools

| Tool Name | Description | Auth Required |
|-----------|-------------|---------------|
| `list_my_ai_personas` | List user's AI personas with fuzzy search | Yes |
| `create_ai_persona_or_digital_twin` | Create persona via clone/keywords/link modes | No (demo mode) |
| `talk_to_ai_persona` | Chat with a persona by ID or fuzzy name match | Yes |
| `check_ai_persona_training_progress` | Poll creation progress | Yes |
| `create_panel` | Create survey panel with groups of sparks | Yes |
| `ask_panel` | Ask question to all panel groups, get aggregated results | Yes |
| `export_panel` | Export panel survey results | Yes |

### Tool Implementation Pattern

```typescript
// server/mcp/tools/myTool.ts
import type { McpServerContext } from '../types'

export const myTool = {
  name: 'my_tool_name',
  config: {
    title: 'Human Readable Title',
    description: 'When to use this tool...',
    inputSchema: {
      type: 'object',
      properties: {
        param1: { type: 'string', description: '...' },
      },
      required: ['param1'],
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      costHint: 'low', // low | medium | high
      timeoutHint: 10000,
      confirmationHint: false,
    },
    _meta: {
      'openai/visibility': 'public',
      'openai/scopes': ['sparks:read'],
    },
  },

  handler: async (args: MyToolArgs, context: McpServerContext) => {
    const { apiCall } = createApiClient({ authToken: context.apiKey, apiBaseUrl: context.apiBaseUrl })

    try {
      const result = await apiCall('/api/v1/endpoint', { method: 'POST', body: JSON.stringify(args) })

      return {
        content: [{ type: 'text', text: 'Success message' }],
        structuredContent: { /* data for widget */ },
      }
    } catch (error) {
      return {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      }
    }
  }
}
```

### Adding a New Tool

1. Create `server/mcp/tools/myNewTool.ts` following the pattern above
2. Add input schema types to `server/mcp/types.ts` if using Zod
3. Export from `server/mcp/tools/index.ts`
4. Register in `server/mcp/server.ts`:
   ```typescript
   import { myNewTool } from './tools/myNewTool'

   server.registerTool(
     myNewTool.name,
     myNewTool.config,
     async (args) => myNewTool.handler(args as any, getContext())
   )
   ```
5. If tool needs auth, ensure it's not in `PUBLIC_TOOLS` array in `config.ts`
6. Add operation-specific rate limit in `RATE_LIMIT_CONFIG.operationLimits` if needed

## Resources

### Spark Widget (`ai-persona-widget`)

Interactive HTML widget served at `ui://widget/spark.html`:

- **Creation mode**: Shows real-time training progress with SSE updates
- **Chat mode**: Embedded chat interface with initial message/response
- Uses `text/html+skybridge` MIME type for ChatGPT rendering

Implementation: `server/mcp/resources/sparkWidget.ts`

## Security

### Rate Limiting

Sliding window rate limiting per IP or authenticated user:

| Target | Limit |
|--------|-------|
| Unauthenticated (per IP) | 100 req/min |
| Authenticated | 1000 req/min |
| `create_ai_persona_or_digital_twin` | 20/min |
| `talk_to_ai_persona` | 60/min |
| Generic `tools/call` | 100/min |

Implementation: `server/mcp/middleware/rateLimit.ts`

Response headers: `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `Retry-After`

### Circuit Breakers

Protect against cascading failures for internal API calls:

- **Failure threshold**: 5 failures opens circuit
- **Reset timeout**: 30 seconds before half-open
- **Success threshold**: 2 successes to close from half-open

Implementation: `server/mcp/utils/circuitBreaker.ts`

```typescript
import { withCircuitBreaker } from './utils/circuitBreaker'

const result = await withCircuitBreaker('internal-api', async () => {
  return fetch(url, options)
}, {
  fallback: () => { throw serviceUnavailable('Internal API') }
})
```

### CORS

Allowed origins in `server/mcp/config.ts`:

- `https://chat.openai.com`, `https://chatgpt.com`
- `https://claude.ai`
- `https://getminds.ai`, `https://staging.getminds.ai`
- Development: `localhost:3000`, `localhost:5173`
- Pattern matches: `*.openai.com`, `*.ngrok-free.app`, etc.

### Audit Logging

Security events logged via `server/mcp/utils/audit.ts`:

- `authAttempt` - Authentication attempts
- `authFailure` - Failed auth
- `toolInvoke` - Tool calls
- `toolSuccess` / `toolFailure` - Tool results
- `rateLimitExceeded` - Rate limit hits
- `internalError` - Server errors

## Error Handling

MCP error codes in `server/mcp/utils/errors.ts`:

| Code | Name | HTTP Status |
|------|------|-------------|
| -32700 | PARSE_ERROR | 400 |
| -32600 | INVALID_REQUEST | 400 |
| -32601 | METHOD_NOT_FOUND | 404 |
| -32602 | INVALID_PARAMS | 400 |
| -32603 | INTERNAL_ERROR | 500 |
| -32001 | AUTHENTICATION_REQUIRED | 401 |
| -32002 | RATE_LIMIT_EXCEEDED | 429 |
| -32003 | RESOURCE_NOT_FOUND | 404 |
| -32004 | PERMISSION_DENIED | 403 |
| -32005 | TIMEOUT | 504 |
| -32006 | SERVICE_UNAVAILABLE | 503 |
| -32008 | CIRCUIT_BREAKER_OPEN | 503 |

Error factory functions:
```typescript
import { authenticationRequired, rateLimitExceeded, resourceNotFound } from './utils/errors'

throw authenticationRequired('https://getminds.ai/.well-known/oauth-protected-resource')
throw rateLimitExceeded(60) // retry after 60 seconds
throw resourceNotFound('Spark', sparkId)
```

## Configuration

### Environment Variables

| Variable | Purpose |
|----------|---------|
| `MINDSAI_API_KEY` | API key for stdio transport |
| `SITE_URL` | Public base URL (for OAuth redirects) |

### Cache TTLs (`server/mcp/config.ts`)

| Cache | TTL |
|-------|-----|
| Spark creation dedup | 10 seconds |
| OAuth token validation | 1 minute |
| Latest spark (widget) | 30 minutes |
| Widget token | 5 minutes |
| Recent spark association | 30 seconds |

### Timeouts

| Operation | Timeout |
|-----------|---------|
| Default API call | 30 seconds |
| Spark creation | 60 seconds |
| Chat completion | 45 seconds |
| Polling | 5 seconds |

## Testing with MCP Inspector

Use the MCP Inspector to test tools and resources:

```bash
# Install MCP Inspector
npm install -g @anthropic-ai/mcp-inspector

# Run against local server
mcp-inspector http://localhost:3000/mcp

# Run against production
mcp-inspector https://api.getminds.ai/mcp
```

Or use the web interface at https://inspector.mcp.run

## Utilities

| Utility | Purpose |
|---------|---------|
| `utils/apiClient.ts` | `createApiClient()` with timeout and circuit breaker |
| `utils/fuzzyMatch.ts` | `findBestMatch()` for spark name matching |
| `utils/tokens.ts` | `generateUserDiscoveryToken()` for widget correlation |
| `utils/cache.ts` | In-memory caches for deduplication |
| `utils/metrics.ts` | Request/error/tool invocation metrics |
| `utils/validation.ts` | Input validation helpers |
| `utils/audit.ts` | Security event logging |

## File Map

### Core Server
- `server/mcp/server.ts` - `createMindsServer()` factory, tool/resource registration
- `server/mcp/config.ts` - Configuration, CORS, rate limits, logging
- `server/mcp/types.ts` - Zod schemas, TypeScript types, `McpServerContext`

### Transports
- `server/routes/mcp.ts` - HTTP route handler with rate limiting, metrics
- `server/mcp/stdio.ts` - stdio transport entry point
- `server/mcp/stdioServer.ts` - `createStdioServer()` for stdio transport
- `server/mcp/http.ts` - Standalone HTTP server (for testing)
- `server/mcp/main.ts` - Session-based HTTP server (for testing)

### Tools
- `server/mcp/tools/index.ts` - Barrel export
- `server/mcp/tools/listSparks.ts` - List personas
- `server/mcp/tools/createSpark.ts` - Create persona (demo mode with progress)
- `server/mcp/tools/chatWithSpark.ts` - Chat with persona
- `server/mcp/tools/getSparkStatus.ts` - Check training progress
- `server/mcp/tools/createPanel.ts` - Create survey panel
- `server/mcp/tools/askPanel.ts` - Ask panel question
- `server/mcp/tools/exportPanel.ts` - Export panel results

### Resources
- `server/mcp/resources/sparkWidget.ts` - Spark widget resource
- `server/mcp/resources/widgetLoader.ts` - Widget HTML loader

### Middleware & Utilities
- `server/mcp/middleware/rateLimit.ts` - Rate limiting
- `server/mcp/utils/apiClient.ts` - API client with circuit breaker
- `server/mcp/utils/circuitBreaker.ts` - Circuit breaker implementation
- `server/mcp/utils/errors.ts` - MCP error codes and factories
- `server/mcp/utils/metrics.ts` - Prometheus-style metrics
- `server/mcp/utils/audit.ts` - Security audit logging
- `server/mcp/utils/fuzzyMatch.ts` - Fuzzy string matching
- `server/mcp/utils/tokens.ts` - Token generation
- `server/mcp/utils/cache.ts` - In-memory caches
- `server/mcp/utils/validation.ts` - Input validation

### OAuth
- `server/routes/oauth/authorize.get.ts` - OAuth authorization
- `server/routes/oauth/callback.get.ts` - OAuth callback
- `server/routes/oauth/token.post.ts` - Token exchange
- `server/routes/oauth/register.post.ts` - Dynamic client registration
- `server/routes/.well-known/oauth-authorization-server.get.ts` - OAuth metadata
- `server/routes/.well-known/oauth-protected-resource.get.ts` - Protected resource metadata

## Common Tasks

### Debug MCP requests

Enable debug logging in `server/mcp/config.ts`:
```typescript
// Set NODE_ENV=development for debug logs
export const isDevelopment = process.env.NODE_ENV === 'development'
```

Check health endpoint:
```bash
curl https://api.getminds.ai/mcp
```

### Add rate limit for a new tool

In `server/mcp/config.ts`:
```typescript
export const RATE_LIMIT_CONFIG = {
  operationLimits: {
    // Add your tool
    'my_new_tool': 30,  // 30 per minute
  },
}
```

### Test OAuth flow locally

1. Register a test OAuth client in the database
2. Use ngrok to expose local server: `ngrok http 3000`
3. Update OAuth client redirect URIs to include ngrok URL
4. Test with MCP Inspector or manual flow

### Monitor circuit breaker state

Check health endpoint for circuit breaker stats:
```bash
curl https://api.getminds.ai/mcp | jq '.components'
```
