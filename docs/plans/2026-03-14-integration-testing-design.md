# Integration Testing Strategy Design

## Problem

79 test files, all unit tests with heavy mocking. Every boundary is mocked (`child_process.spawn`, `fetch`, SQLite, channels). The 2 "integration" tests still mock subsystems — they test wiring between mocks, not between real modules. Real failures happen at process boundaries (spawning claude CLI), network boundaries (HTTP gateway), and system boundaries (launchd/systemd).

## Design

### Testing Tiers

| Tier | Scope | Mocked | Real | Config File |
|------|-------|--------|------|-------------|
| **Unit** (existing) | Pure logic, transforms | Everything external | Functions, types | `vitest.config.ts` |
| **Component Integration** | Module boundaries | `claude` CLI, external APIs | SQLite, Pool, MCP RPC, FS | `vitest.integration.config.ts` |
| **System Integration** | Full gateway boot | Anthropic API | HTTP, fake-claude, FS, SQLite | `vitest.e2e.config.ts` |
| **Smoke** (opt-in) | Real running gateway | Nothing | Everything including real Claude | `vitest.smoke.config.ts` |

No tier except Smoke requires an API key.

### Fake Claude Binary

`test/fixtures/fake-claude.ts` — a Node.js script that mimics `claude -p --output-format stream-json`. Controlled via env vars:

- `FAKE_CLAUDE_RESPONSE` — response text (default: "Hello from fake claude")
- `FAKE_CLAUDE_DELAY_MS` — delay before responding (default: 50)
- `FAKE_CLAUDE_EXIT_CODE` — exit code (default: 0)
- `FAKE_CLAUDE_CRASH` — if "true", exit immediately with code 1
- `FAKE_CLAUDE_HANG` — if "true", never exit (test timeout handling)
- `FAKE_CLAUDE_EVENTS` — path to NDJSON file to replay custom event sequences

Emits the same NDJSON event stream as real Claude: `system/init` → `assistant` → `result`.

### Production Code Changes

1. **Injectable binary path in `spawn.ts`:** `options?.claudeBinary ?? "claude"` — dependency injection, not test-only code.
2. **`port: 0` support in gateway:** Ensure `startHttpServer` returns actual assigned port when given `port: 0`.

### Component Integration Tests (`*.integration.test.ts`)

Co-located with source. Test real module boundaries without mocking internal collaborators.

#### Engine Integration
- Spawn fake-claude binary via real `child_process.spawn`
- Verify NDJSON stream parsing, exit code handling, session ID extraction
- Test process pool concurrency (4 tasks, max 2 concurrent) with real subprocesses
- Test crash recovery and timeout killing

#### HTTP Gateway Integration
- Use Hono's `app.request()` for HTTP stack testing without TCP
- Test auth middleware, body validation, payload size limits
- Wire real router + real pool (with fake-claude)

#### Router Integration
- Real router with real command handlers
- Verify gateway commands (`/help`, `/status`) return without spawning
- Verify skill trigger matching injects skill body as prompt
- Verify session management (first message vs resume)

#### Memory Integration
- Real SQLite (temp file, not `:memory:` — catches locking issues)
- Real FTS5 indexing and search
- Mock embeddings only (no API key needed)
- Test file sync → index → search round-trip

#### MCP Server Integration
- Spawn real MCP server as stdio subprocess
- Send JSON-RPC `initialize` → `tools/list` → `tools/call` via stdin
- Verify tool list includes expected tools
- Verify `memory_search` tool invokes real gateway API
- Test child mode restrictions (no `send_message`)

#### Channel Integration
- Mock Telegram API on localhost using Hono (grammY supports `client: { apiRoot }` override)
- Mock Slack API on localhost (`slackApiUrl` option in Bolt)
- Test real bot serialization, retry logic, error handling against controlled mock server
- Verify message formatting, chunking, typing indicators

#### Cron Integration
- Real timers with short intervals (100ms) in integration tests
- Use `vi.waitFor()` for assertions, not fake timers
- Test job fires → routes through real router → dispatches response
- Test heartbeat wake reasons with real `HEARTBEAT.md` files

### System Integration Tests (`src/integration/*.integration.test.ts`)

Full gateway boot with fake-claude binary:

1. Boot real gateway with `port: 0`, temp config, fake-claude binary
2. Send real HTTP requests via `fetch()` to `http://127.0.0.1:${port}`
3. Test full message lifecycle: HTTP request → router → pool → fake-claude → response
4. Test cron API lifecycle: create → list → remove
5. Test graceful shutdown: drains pool, closes server, no lingering processes

### Smoke Tests (opt-in, `test/smoke/`)

Gated behind `OPENCLAUDE_SMOKE=1`. Requires real Claude CLI authenticated on the machine.

- Health check, status endpoint, memory search against real running gateway
- Run manually or nightly, never in default CI

### Test Observability

#### Custom Test Context

A `TestContext` class that collects diagnostic info during tests and flushes on failure only:

- Subprocess stdout/stderr capture — dumped in failure output
- HTTP request/response log — every exchange recorded
- MCP JSON-RPC exchange log
- Port and PID tracking for debugging zombies/conflicts

#### Subsystem Labels in Output

Custom Vitest reporter that prefixes test names with subsystem tags:
```
✓ [engine] spawns fake-claude, parses NDJSON → 120ms
✓ [gateway] POST /api/send routes to pool → 45ms
✗ [mcp] tools/call memory_search → timeout after 5000ms
  └─ captured stderr: "ECONNREFUSED 127.0.0.1:52341"
```

#### Timing Waterfall (System Tests)

Log boot timing breakdown on failure:
```
gateway boot: 340ms
  ├─ config load: 12ms
  ├─ sqlite init: 89ms
  ├─ http listen: 4ms (port 52341)
  └─ pool ready: 2ms
```

#### Failure Dump Strategy

- **On pass:** Silent — no extra output
- **On fail:** Dump all collected context (subprocess output, HTTP log, timing, PIDs)
- Uses Vitest's `onTestFailed` hook

### Test Infrastructure

#### File Structure
```
test/
├── fixtures/
│   ├── fake-claude.ts          # Mock CLI binary
│   ├── payloads/               # Telegram/Slack webhook payloads
│   └── mcp/                    # Mock tool definitions, NDJSON event files
├── helpers/
│   ├── config.ts               # Test config factory (port:0, temp dirs)
│   ├── cleanup.ts              # Cleanup registry (reverse-order teardown)
│   ├── test-context.ts         # Diagnostic log collector
│   ├── json-rpc.ts             # sendJsonRpc() helper for MCP tests
│   └── mock-channel-server.ts  # Hono-based mock Telegram/Slack API
└── smoke/
    └── live.test.ts            # Opt-in live tests
```

#### Vitest Configs
- `vitest.config.ts` — unit tests, 30s timeout, `src/**/*.test.ts` excluding `*.integration.test.ts` and `*.e2e.test.ts`
- `vitest.integration.config.ts` — component integration, 60s timeout, `src/**/*.integration.test.ts`
- `vitest.e2e.config.ts` — system integration, 120s timeout, `src/integration/*.integration.test.ts`
- `vitest.smoke.config.ts` — smoke tests, 300s timeout, `test/smoke/**/*.test.ts`

#### Package.json Scripts
```json
{
  "test": "vitest --watch",
  "test:run": "vitest run",
  "test:integration": "vitest run --config vitest.integration.config.ts",
  "test:e2e": "vitest run --config vitest.e2e.config.ts",
  "test:smoke": "OPENCLAUDE_SMOKE=1 vitest run --config vitest.smoke.config.ts",
  "test:all": "vitest run && vitest run --config vitest.integration.config.ts && vitest run --config vitest.e2e.config.ts"
}
```

### CI Pipeline

```
Every commit:     lint + typecheck + unit tests (~30s)
After unit pass:  integration tests (~2min)
Nightly/manual:   smoke tests (real API, gated)
```

### What This Strategy Cannot Test

1. **Real Claude API behavior** — if Anthropic changes NDJSON format, only smoke tests catch it
2. **launchd/systemd behavior** — can't test `launchctl bootstrap` in CI
3. **Real Telegram edge cases** — 409 conflicts, rate limits, connection resets
4. **Cross-platform process group cleanup** — `kill(-pid)` differs between macOS and Linux

### Implementation Priority

1. Fake claude binary + injectable binary path in `spawn.ts`
2. Test infrastructure (helpers, config factory, cleanup registry, test context)
3. Engine integration tests (subprocess boundary — most production bugs)
4. HTTP gateway integration tests (easy win with `app.request()`)
5. MCP server integration tests (critical untested boundary)
6. System integration tests (full gateway boot)
7. Channel mock servers + integration tests
8. Cron/heartbeat integration tests
9. Custom Vitest reporter with observability features
10. Smoke tests

### Sources

- OpenClaw upstream: multi-suite Vitest configs, test-utils/, Docker test runners
- Codex CLI: mock SSE server (`ResponseMock`), sandbox-aware tests
- Gemini CLI: `TestRig` pattern for subprocess lifecycle, tool restriction per test
- GitHub CLI: `testscript` declarative acceptance tests, three-tier strategy
- llmock (CopilotKit): cross-process LLM API mocking
- telegram-test-api: local Telegram API simulation
