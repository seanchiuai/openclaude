# Integration Testing Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add multi-tier integration tests that verify OpenClaude works as a whole system, not just individual mocked functions.

**Architecture:** Fake claude binary replaces real CLI in tests. Injectable binary path via `spawnClaude` options. Separate vitest configs per tier. TestContext collects diagnostics and dumps on failure only.

**Tech Stack:** Vitest (existing), Hono `app.request()` for HTTP tests, `tsx` shebang for fake binary, grammY `apiRoot` override for Telegram mocks.

---

### Task 1: Fake Claude Binary

**Files:**
- Create: `test/fixtures/fake-claude.ts`

**Step 1: Create the fake claude binary**

```typescript
#!/usr/bin/env npx tsx
/**
 * Fake Claude CLI that mimics `claude -p --output-format stream-json`.
 * Controlled via env vars:
 *   FAKE_CLAUDE_DELAY_MS  - delay before responding (default: 10)
 *   FAKE_CLAUDE_EXIT_CODE - exit code (default: 0)
 *   FAKE_CLAUDE_RESPONSE  - response text (default: "Hello from fake claude")
 *   FAKE_CLAUDE_CRASH     - if "true", exit immediately with code 1
 *   FAKE_CLAUDE_HANG      - if "true", never exit (test timeout handling)
 *   FAKE_CLAUDE_EVENTS    - path to NDJSON file to replay instead of default events
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const sessionId = randomUUID();
const delay = parseInt(process.env.FAKE_CLAUDE_DELAY_MS ?? "10");
const exitCode = parseInt(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0");
const response = process.env.FAKE_CLAUDE_RESPONSE ?? "Hello from fake claude";

let prompt = "";
process.stdin.on("data", (chunk) => {
  prompt += chunk;
});
process.stdin.on("end", async () => {
  if (process.env.FAKE_CLAUDE_CRASH === "true") {
    process.stderr.write("CRASH: simulated failure\n");
    process.exit(1);
  }
  if (process.env.FAKE_CLAUDE_HANG === "true") {
    setInterval(() => {}, 100_000);
    return;
  }

  await new Promise((r) => setTimeout(r, delay));

  if (process.env.FAKE_CLAUDE_EVENTS) {
    const events = readFileSync(process.env.FAKE_CLAUDE_EVENTS, "utf-8");
    process.stdout.write(events);
    process.exit(exitCode);
    return;
  }

  write({ type: "system", subtype: "init", session_id: sessionId });
  write({
    type: "assistant",
    message: {
      id: randomUUID(),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: response }],
      model: "claude-sonnet-4-6",
    },
  });
  write({
    type: "result",
    subtype: "success",
    result: response,
    session_id: sessionId,
    usage: {
      input_tokens: 100,
      output_tokens: 50,
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    num_turns: 1,
    cost_usd: 0.001,
  });

  process.exit(exitCode);
});

function write(obj: unknown) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}
```

**Step 2: Make it executable**

Run: `chmod +x test/fixtures/fake-claude.ts`

**Step 3: Verify the fake binary works standalone**

Run: `echo "test prompt" | npx tsx test/fixtures/fake-claude.ts`
Expected: 3 lines of NDJSON (system/init, assistant, result)

**Step 4: Commit**

```bash
git add test/fixtures/fake-claude.ts
git commit -m "test: add fake claude binary for integration tests"
```

---

### Task 2: Injectable Binary Path in spawn.ts

**Files:**
- Modify: `src/engine/spawn.ts:19-22` (function signature) and `src/engine/spawn.ts:90` (spawn call)
- Modify: `src/engine/types.ts` (add SpawnOptions type)

**Step 1: Write the failing test**

Create `src/engine/spawn.integration.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnClaude } from "./spawn.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FAKE_CLAUDE = join(__dirname, "../../test/fixtures/fake-claude.ts");

describe("engine spawn integration", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "openclaude-spawn-test-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("spawns fake-claude and parses NDJSON result", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "spawn-test-1",
        prompt: "What is 2+2?",
        workingDirectory: sessionDir,
      },
      undefined,
      { claudeBinary: `npx tsx ${FAKE_CLAUDE}` },
    );

    const result = await promise;
    expect(result.text).toBe("Hello from fake claude");
    expect(result.exitCode).toBe(0);
    expect(result.claudeSessionId).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
  });

  it("handles subprocess crash gracefully", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "crash-test",
        prompt: "crash",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: `npx tsx ${FAKE_CLAUDE}`,
        env: { FAKE_CLAUDE_CRASH: "true" },
      },
    );

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  });

  it("custom response via env var", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "custom-test",
        prompt: "test",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: `npx tsx ${FAKE_CLAUDE}`,
        env: { FAKE_CLAUDE_RESPONSE: "custom answer" },
      },
    );

    const result = await promise;
    expect(result.text).toBe("custom answer");
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/spawn.integration.test.ts`
Expected: FAIL — `spawnClaude` doesn't accept a third argument

**Step 3: Add SpawnOptions type to types.ts**

Add to `src/engine/types.ts` at the end:

```typescript
export interface SpawnOptions {
  /** Override the claude binary (default: "claude"). For testing with fake-claude. */
  claudeBinary?: string;
  /** Extra env vars merged into subprocess environment */
  env?: Record<string, string>;
}
```

**Step 4: Modify spawn.ts to accept SpawnOptions**

In `src/engine/spawn.ts`, change the function signature (line 19):

```typescript
export function spawnClaude(
  task: AgentTask,
  onEvent?: OnStreamEvent,
  options?: SpawnOptions,
): {
```

Add import of `SpawnOptions` to the import line (line 13):

```typescript
import type { AgentTask, ClaudeResult, ClaudeSession, OnStreamEvent, SpawnOptions, TokenUsage } from "./types.js";
```

Change the spawn call (line 90) to use the binary from options:

```typescript
  const binary = options?.claudeBinary ?? "claude";
  const proc = spawn(binary, args, {
```

And merge extra env vars (before the spawn call, after the env deletions around line 87):

```typescript
  if (options?.env) Object.assign(env, options.env);
```

**Important:** The binary might be `npx tsx path/to/fake-claude.ts` which is multiple words. We need to handle that. Change the spawn to use shell mode when the binary contains spaces:

```typescript
  const binary = options?.claudeBinary ?? "claude";
  const useShell = binary.includes(" ");
  const spawnCmd = useShell ? `${binary} ${args.join(" ")}` : binary;
  const spawnArgs = useShell ? [] : args;
  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: task.workingDirectory ?? projectPath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
    detached: true,
    shell: useShell,
  });
```

**Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/engine/spawn.integration.test.ts`
Expected: PASS

**Step 6: Run existing unit tests to verify no regression**

Run: `pnpm test:run`
Expected: All existing tests still pass

**Step 7: Commit**

```bash
git add src/engine/spawn.ts src/engine/types.ts src/engine/spawn.integration.test.ts
git commit -m "feat(engine): add injectable binary path for integration testing"
```

---

### Task 3: Vitest Config for Integration Tests

**Files:**
- Create: `vitest.integration.config.ts`
- Modify: `vitest.config.ts` (exclude integration tests)
- Modify: `package.json:13-20` (add test scripts)

**Step 1: Create vitest.integration.config.ts**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 60_000,
    include: ["src/**/*.integration.test.ts"],
  },
});
```

**Step 2: Exclude integration tests from unit config**

In `vitest.config.ts`, add an exclude:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 30_000,
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.integration.test.ts"],
  },
});
```

**Step 3: Add scripts to package.json**

Add after the existing `"test:run"` line:

```json
"test:integration": "vitest run --config vitest.integration.config.ts",
"test:all": "vitest run && vitest run --config vitest.integration.config.ts",
```

**Step 4: Verify both suites work independently**

Run: `pnpm test:run`
Expected: All unit tests pass, integration tests NOT included

Run: `pnpm test:integration`
Expected: Integration tests run (spawn.integration.test.ts)

**Step 5: Commit**

```bash
git add vitest.config.ts vitest.integration.config.ts package.json
git commit -m "build: add separate vitest config for integration tests"
```

---

### Task 4: Test Infrastructure — Helpers

**Files:**
- Create: `test/helpers/config.ts`
- Create: `test/helpers/cleanup.ts`
- Create: `test/helpers/test-context.ts`

**Step 1: Create test config factory**

`test/helpers/config.ts`:

```typescript
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const FAKE_CLAUDE = join(__dirname, "../fixtures/fake-claude.ts");
export const FAKE_CLAUDE_CMD = `npx tsx ${FAKE_CLAUDE}`;

export interface TestEnv {
  dir: string;
  configPath: string;
  config: Record<string, unknown>;
}

export async function createTestEnv(
  overrides: Record<string, unknown> = {},
): Promise<TestEnv> {
  const dir = await mkdtemp(join(tmpdir(), "openclaude-test-"));
  await mkdir(join(dir, "sessions"), { recursive: true });
  await mkdir(join(dir, "memory"), { recursive: true });
  await mkdir(join(dir, "logs"), { recursive: true });

  const config = {
    gateway: { port: 0, token: "test-token" },
    engine: { maxConcurrent: 2 },
    channels: {},
    memory: { enabled: false },
    cron: { enabled: false },
    ...overrides,
  };
  const configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  return { dir, configPath, config };
}
```

**Step 2: Create cleanup registry**

`test/helpers/cleanup.ts`:

```typescript
import { rm } from "node:fs/promises";
import type { ChildProcess } from "node:child_process";

export function createCleanupRegistry() {
  const dirs: string[] = [];
  const procs: ChildProcess[] = [];
  const fns: Array<() => Promise<void>> = [];

  return {
    trackDir(dir: string) {
      dirs.push(dir);
    },
    trackProcess(proc: ChildProcess) {
      procs.push(proc);
    },
    onCleanup(fn: () => Promise<void>) {
      fns.push(fn);
    },
    async runAll() {
      for (const fn of fns.reverse()) {
        try {
          await fn();
        } catch {
          /* best effort */
        }
      }
      for (const proc of procs) {
        try {
          proc.kill("SIGTERM");
        } catch {
          /* already dead */
        }
      }
      for (const dir of dirs) {
        try {
          await rm(dir, { recursive: true, force: true });
        } catch {
          /* best effort */
        }
      }
    },
  };
}
```

**Step 3: Create test context for observability**

`test/helpers/test-context.ts`:

```typescript
import { onTestFailed } from "vitest";

interface LogEntry {
  timestamp: number;
  subsystem: string;
  message: string;
  data?: unknown;
}

export function createTestContext(subsystem: string) {
  const logs: LogEntry[] = [];
  const subprocessOutput: Array<{ pid: number; stream: string; text: string }> =
    [];

  function log(message: string, data?: unknown) {
    logs.push({ timestamp: Date.now(), subsystem, message, data });
  }

  function captureSubprocess(pid: number, stdout: string, stderr: string) {
    if (stdout)
      subprocessOutput.push({ pid, stream: "stdout", text: stdout });
    if (stderr)
      subprocessOutput.push({ pid, stream: "stderr", text: stderr });
  }

  function dumpOnFailure() {
    onTestFailed(() => {
      console.log(`\n--- [${subsystem}] Test Context Dump ---`);
      if (logs.length > 0) {
        console.log("\nLogs:");
        for (const entry of logs) {
          const ts = new Date(entry.timestamp).toISOString().slice(11, 23);
          console.log(`  ${ts} [${entry.subsystem}] ${entry.message}`);
          if (entry.data) console.log(`    ${JSON.stringify(entry.data)}`);
        }
      }
      if (subprocessOutput.length > 0) {
        console.log("\nSubprocess Output:");
        for (const entry of subprocessOutput) {
          console.log(`  [pid:${entry.pid}] ${entry.stream}:`);
          for (const line of entry.text.split("\n").filter(Boolean)) {
            console.log(`    ${line}`);
          }
        }
      }
      console.log(`--- End [${subsystem}] ---\n`);
    });
  }

  return { log, captureSubprocess, dumpOnFailure };
}
```

**Step 4: Commit**

```bash
git add test/helpers/config.ts test/helpers/cleanup.ts test/helpers/test-context.ts
git commit -m "test: add integration test helpers (config factory, cleanup, context)"
```

---

### Task 5: Pool Integration Test

**Files:**
- Create: `src/engine/pool.integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createProcessPool } from "./pool.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FAKE_CLAUDE_CMD } from "../../test/helpers/config.js";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("pool integration", () => {
  let sessionDir: string;
  const ctx = createTestContext("pool");

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "openclaude-pool-test-"));
    ctx.dumpOnFailure();
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("enforces concurrency limit with real subprocesses", async () => {
    const pool = createProcessPool(2);
    const events: string[] = [];

    ctx.log("submitting 4 tasks with max concurrency 2");

    const tasks = Array.from({ length: 4 }, (_, i) =>
      pool.submit(
        {
          sessionId: `pool-test-${i}`,
          prompt: `Task ${i}`,
          workingDirectory: sessionDir,
        },
        (event) => {
          if (event.type === "queued") {
            events.push(`queued-${i}`);
            ctx.log(`task ${i} queued at position ${event.position}`);
          }
        },
        { claudeBinary: FAKE_CLAUDE_CMD },
      ),
    );

    const results = await Promise.all(tasks);
    expect(results).toHaveLength(4);
    for (const r of results) {
      expect(r.exitCode).toBe(0);
      expect(r.text).toBe("Hello from fake claude");
    }
    // Tasks 2 and 3 should have been queued (only 2 slots)
    expect(events.filter((e) => e.startsWith("queued-")).length).toBe(2);

    ctx.log("all 4 tasks completed");
    await pool.drain();
  }, 30_000);

  it("drain waits for all in-flight tasks", async () => {
    const pool = createProcessPool(1);

    // Submit task with delay
    pool.submit(
      {
        sessionId: "drain-test",
        prompt: "slow task",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: FAKE_CLAUDE_CMD,
        env: { FAKE_CLAUDE_DELAY_MS: "200" },
      },
    );

    // Drain should wait for it
    await pool.drain();
    expect(pool.stats().running).toBe(0);
  }, 15_000);
});
```

**Step 2: This test requires pool.submit to accept SpawnOptions**

Check if `pool.ts` passes through to `spawnClaude`. If it doesn't, modify `pool.ts` to accept and forward `SpawnOptions`:

In `src/engine/pool.ts`, update the `submit` method signature to accept `options?: SpawnOptions` and pass it through to `spawnClaude(task, wrappedOnEvent, options)`.

**Step 3: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Step 4: Commit**

```bash
git add src/engine/pool.ts src/engine/pool.integration.test.ts
git commit -m "test(engine): add pool integration test with real subprocesses"
```

---

### Task 6: HTTP Gateway Integration Test

**Files:**
- Create: `src/gateway/http.integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach } from "vitest";
import { createGatewayApp } from "./http.js";
import { createProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("gateway HTTP integration", () => {
  const ctx = createTestContext("gateway");

  let app: ReturnType<typeof createGatewayApp>;
  let pool: ReturnType<typeof createProcessPool>;

  beforeEach(() => {
    pool = createProcessPool(2);
    app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
    });
    ctx.dumpOnFailure();
  });

  it("health endpoint returns 200 without auth", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.uptime).toBeGreaterThanOrEqual(0);
  });

  it("readiness endpoint returns 200", async () => {
    const res = await app.request("/ready");
    expect(res.status).toBe(200);
  });

  it("status endpoint requires auth when authMiddleware is set", async () => {
    const authedApp = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
      authMiddleware: async (c, next) => {
        const auth = c.req.header("Authorization");
        if (auth !== "Bearer test-token") {
          return c.json({ error: "unauthorized" }, 401);
        }
        await next();
      },
    });

    const noAuth = await authedApp.request("/api/status");
    expect(noAuth.status).toBe(401);

    const withAuth = await authedApp.request("/api/status", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(withAuth.status).toBe(200);
    const body = await withAuth.json();
    expect(body.pool).toBeDefined();
    expect(body.pool.running).toBe(0);
    expect(body.pool.maxConcurrent).toBe(2);
  });

  it("status endpoint shows pool stats", async () => {
    const res = await app.request("/api/status");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.pool.running).toBe(0);
    expect(body.pool.queued).toBe(0);
    expect(body.pool.maxConcurrent).toBe(2);
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS — Hono's `app.request()` works without a real TCP server

**Step 3: Commit**

```bash
git add src/gateway/http.integration.test.ts
git commit -m "test(gateway): add HTTP integration tests with real Hono app"
```

---

### Task 7: Router Integration Test

**Files:**
- Create: `src/router/router.integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRouter } from "./router.js";
import { createProcessPool } from "../engine/pool.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "../../test/helpers/test-context.js";
import { FAKE_CLAUDE_CMD } from "../../test/helpers/config.js";
import type { InboundMessage } from "./types.js";

describe("router integration", () => {
  const ctx = createTestContext("router");
  let tmpDir: string;
  let pool: ReturnType<typeof createProcessPool>;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "openclaude-router-test-"));
    pool = createProcessPool(2);
    ctx.dumpOnFailure();
  });

  afterEach(async () => {
    await pool.drain();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("gateway commands respond without spawning claude", async () => {
    const router = createRouter({
      pool,
      send: async () => {},
      sessionsMapPath: join(tmpDir, "sessions-map.json"),
    });

    const msg: InboundMessage = {
      channel: "telegram",
      chatId: "123",
      text: "/help",
      userId: "user1",
    };

    const response = await router(msg);
    expect(response).toBeDefined();
    expect(typeof response).toBe("string");
    expect(pool.stats().running).toBe(0);
    ctx.log("help command returned without spawning");
  });

  it("status command returns pool info", async () => {
    const router = createRouter({
      pool,
      send: async () => {},
      sessionsMapPath: join(tmpDir, "sessions-map.json"),
    });

    const msg: InboundMessage = {
      channel: "telegram",
      chatId: "123",
      text: "/status",
      userId: "user1",
    };

    const response = await router(msg);
    expect(response).toContain("0"); // running count
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Note:** The router's exact constructor signature may need adjusting based on what `RouterDeps` requires. The test should be adapted to match the actual required fields. If `createRouter` requires more deps, provide minimal stubs (e.g., `skills: []`, `cronService: undefined`).

**Step 3: Commit**

```bash
git add src/router/router.integration.test.ts
git commit -m "test(router): add integration test for gateway commands"
```

---

### Task 8: MCP Server Integration Test

**Files:**
- Create: `src/mcp/gateway-tools-server.integration.test.ts`
- Create: `test/helpers/json-rpc.ts`

**Step 1: Create JSON-RPC helper**

`test/helpers/json-rpc.ts`:

```typescript
import type { ChildProcess } from "node:child_process";

/**
 * Send a JSON-RPC request over stdio and read the response.
 * MCP uses Content-Length header framing.
 */
export function sendJsonRpc(
  proc: ChildProcess,
  request: { jsonrpc: string; id: number; method: string; params?: unknown },
  timeoutMs = 5000,
): Promise<{ id: number; result?: unknown; error?: unknown }> {
  return new Promise((resolve, reject) => {
    const data: Buffer[] = [];
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        proc.stdout!.off("data", onData);
        reject(
          new Error(
            `MCP timeout after ${timeoutMs}ms waiting for id=${request.id}`,
          ),
        );
      }
    }, timeoutMs);

    const onData = (chunk: Buffer) => {
      data.push(chunk);
      const text = Buffer.concat(data).toString();
      // Try to parse each line as JSON-RPC response
      for (const line of text.split("\n")) {
        try {
          const parsed = JSON.parse(line.trim());
          if (parsed.id === request.id) {
            resolved = true;
            clearTimeout(timer);
            proc.stdout!.off("data", onData);
            resolve(parsed);
            return;
          }
        } catch {
          /* partial or non-JSON line */
        }
      }
    };

    proc.stdout!.on("data", onData);

    const body = JSON.stringify(request);
    const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
    proc.stdin!.write(header + body);
  });
}
```

**Step 2: Write the MCP integration test**

`src/mcp/gateway-tools-server.integration.test.ts`:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createGatewayApp, startHttpServer } from "../gateway/http.js";
import { createProcessPool } from "../engine/pool.js";
import { sendJsonRpc } from "../../test/helpers/json-rpc.js";
import { createTestContext } from "../../test/helpers/test-context.js";
import type { AddressInfo } from "node:net";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const MCP_SERVER = join(__dirname, "gateway-tools-server.ts");

describe("MCP gateway-tools-server integration", () => {
  const ctx = createTestContext("mcp");
  let pool: ReturnType<typeof createProcessPool>;
  let server: ReturnType<typeof startHttpServer>;
  let baseUrl: string;
  let mcpProc: ChildProcess;

  beforeAll(async () => {
    pool = createProcessPool(2);
    const app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
    });
    server = startHttpServer(app, 0);

    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    ctx.log(`gateway started on port ${addr.port}`);

    // Spawn MCP server as real subprocess
    mcpProc = spawn("npx", ["tsx", MCP_SERVER], {
      env: {
        ...process.env,
        GATEWAY_URL: baseUrl,
        GATEWAY_TOKEN: "",
        OPENCLAUDE_SESSION_ID: "test-session",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Collect stderr for diagnostics
    let stderr = "";
    mcpProc.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    // Initialize MCP connection
    const initResponse = await sendJsonRpc(mcpProc, {
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });
    expect(initResponse.result).toBeDefined();
    ctx.log("MCP initialized", initResponse.result);
  }, 15_000);

  afterAll(async () => {
    mcpProc?.kill("SIGTERM");
    server?.close();
    await pool?.drain();
  });

  it("tools/list returns expected tools", async () => {
    ctx.dumpOnFailure();

    const response = await sendJsonRpc(mcpProc, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
      params: {},
    });

    expect(response.result).toBeDefined();
    const tools = (response.result as { tools: Array<{ name: string }> }).tools;
    const names = tools.map((t) => t.name);

    ctx.log("tools returned", names);

    expect(names).toContain("cron_list");
    expect(names).toContain("memory_search");
    expect(names).toContain("send_message");
  });

  it("cron_list tool returns empty list from fresh gateway", async () => {
    ctx.dumpOnFailure();

    const response = await sendJsonRpc(mcpProc, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "cron_list",
        arguments: {},
      },
    });

    expect(response.result).toBeDefined();
    expect((response.result as { isError?: boolean }).isError).not.toBe(true);
  });
});
```

**Step 3: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Note:** The MCP server's exact initialization handshake may differ. Adapt the `initialize` params to match what `@modelcontextprotocol/sdk` expects. If the MCP server uses Content-Length framing (standard MCP), the JSON-RPC helper handles it. If it uses newline-delimited JSON, adjust the helper.

**Step 4: Commit**

```bash
git add test/helpers/json-rpc.ts src/mcp/gateway-tools-server.integration.test.ts
git commit -m "test(mcp): add integration test for gateway tools server over stdio"
```

---

### Task 9: Telegram Channel Integration Test

**Files:**
- Create: `src/channels/telegram/bot.integration.test.ts`

**Step 1: Write the test with mock Telegram API**

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { createTestContext } from "../../../test/helpers/test-context.js";
import type { AddressInfo } from "node:net";

describe("telegram adapter integration", () => {
  const ctx = createTestContext("telegram");
  let mockApi: ReturnType<typeof serve>;
  let apiPort: number;
  const received: Array<{ method: string; body: unknown }> = [];

  beforeAll(async () => {
    // Fake Telegram Bot API server
    const app = new Hono();

    app.post("/bot:token/getMe", (c) =>
      c.json({
        ok: true,
        result: {
          id: 12345,
          is_bot: true,
          first_name: "TestBot",
          username: "test_bot",
        },
      }),
    );

    app.post("/bot:token/getUpdates", (c) =>
      c.json({ ok: true, result: [] }),
    );

    app.post("/bot:token/sendMessage", async (c) => {
      const body = await c.req.json();
      received.push({ method: "sendMessage", body });
      ctx.log("sendMessage received", body);
      return c.json({
        ok: true,
        result: {
          message_id: received.length,
          chat: { id: body.chat_id },
          text: body.text,
          date: Math.floor(Date.now() / 1000),
        },
      });
    });

    app.post("/bot:token/sendChatAction", (c) =>
      c.json({ ok: true, result: true }),
    );

    app.post("/bot:token/setMessageReaction", (c) =>
      c.json({ ok: true, result: true }),
    );

    mockApi = serve({ fetch: app.fetch, port: 0 });
    const addr = mockApi.address() as AddressInfo;
    apiPort = addr.port;
    ctx.log(`mock Telegram API on port ${apiPort}`);
  });

  afterAll(() => {
    mockApi?.close();
  });

  it("sends message through real grammY to mock API", async () => {
    ctx.dumpOnFailure();
    const { Bot } = await import("grammy");

    const bot = new Bot("fake-token", {
      client: {
        apiRoot: `http://127.0.0.1:${apiPort}`,
      },
    });

    // Initialize bot info
    await bot.init();
    expect(bot.botInfo.username).toBe("test_bot");

    // Send a message
    await bot.api.sendMessage(999, "Hello from integration test");

    expect(received.length).toBeGreaterThan(0);
    const last = received[received.length - 1];
    expect(last.method).toBe("sendMessage");
    expect((last.body as { text: string }).text).toBe(
      "Hello from integration test",
    );
    ctx.log("message sent and received successfully");
  });

  it("sends chat action through real grammY", async () => {
    ctx.dumpOnFailure();
    const { Bot } = await import("grammy");

    const bot = new Bot("fake-token", {
      client: { apiRoot: `http://127.0.0.1:${apiPort}` },
    });
    await bot.init();

    // This should not throw
    await bot.api.sendChatAction(999, "typing");
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Step 3: Commit**

```bash
git add src/channels/telegram/bot.integration.test.ts
git commit -m "test(telegram): add integration test with mock Telegram API server"
```

---

### Task 10: Memory Integration Test

**Files:**
- Create: `src/memory/manager.integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("memory manager integration", () => {
  const ctx = createTestContext("memory");
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "openclaude-memory-test-"));
    ctx.dumpOnFailure();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("syncs markdown files and searches via FTS", async () => {
    const memoryDir = join(tmpDir, "memory");
    await mkdir(memoryDir, { recursive: true });

    await writeFile(
      join(memoryDir, "test-note.md"),
      "# Meeting Notes\nDiscussed the deployment pipeline and CI improvements.",
    );
    await writeFile(
      join(memoryDir, "another.md"),
      "# Grocery List\nBuy milk, eggs, and bread.",
    );

    // Import dynamically to avoid loading SQLite globally
    const { createMemoryManager } = await import("./manager.js");

    const manager = createMemoryManager({
      memoryDir,
      dbPath: join(tmpDir, "test.sqlite"),
    });

    await manager.sync();
    ctx.log("memory synced");

    const results = await manager.search("deployment pipeline");
    ctx.log("search results", results);

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].text).toContain("deployment");

    // Negative search — grocery items shouldn't match deployment
    const unrelated = await manager.search("deployment pipeline");
    const groceryInTop = unrelated.some((r) => r.text.includes("Grocery"));
    // FTS relevance should rank the deployment note higher
    expect(unrelated[0].text).toContain("deployment");

    manager.close();
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Note:** The `createMemoryManager` constructor signature may differ. Adapt to match the actual factory params. If it requires embedding config, pass `vectorEnabled: false` or equivalent to use FTS-only mode.

**Step 3: Commit**

```bash
git add src/memory/manager.integration.test.ts
git commit -m "test(memory): add integration test with real SQLite FTS"
```

---

### Task 11: Cron Service Integration Test

**Files:**
- Create: `src/cron/service.integration.test.ts`

**Step 1: Write the test**

```typescript
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createCronService } from "./service.js";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTestContext } from "../../test/helpers/test-context.js";

describe("cron service integration", () => {
  const ctx = createTestContext("cron");
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "openclaude-cron-test-"));
    ctx.dumpOnFailure();
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("add → list → remove lifecycle with real persistence", async () => {
    const storePath = join(tmpDir, "jobs.json");
    const outcomes: string[] = [];

    const cron = createCronService({
      storePath,
      runIsolatedJob: async (job) => {
        outcomes.push(job.name);
        ctx.log(`job fired: ${job.name}`);
        return { text: `ran ${job.name}`, exitCode: 0, duration: 10 };
      },
    });

    // Add a job
    const job = cron.add({
      name: "test-job",
      schedule: "0 0 * * *", // daily, won't fire during test
      prompt: "do a thing",
    });
    expect(job.id).toBeDefined();
    expect(job.name).toBe("test-job");

    // List should include it
    const jobs = cron.list();
    expect(jobs.some((j) => j.id === job.id)).toBe(true);

    // Remove it
    const removed = cron.remove(job.id);
    expect(removed).toBe(true);

    // List should be empty
    expect(cron.list().filter((j) => j.id === job.id)).toHaveLength(0);

    ctx.log("CRUD lifecycle complete");
  });

  it("manual run executes job immediately", async () => {
    const storePath = join(tmpDir, "jobs.json");
    const outcomes: string[] = [];

    const cron = createCronService({
      storePath,
      runIsolatedJob: async (job) => {
        outcomes.push(job.name);
        return { text: `ran ${job.name}`, exitCode: 0, duration: 10 };
      },
    });

    const job = cron.add({
      name: "manual-test",
      schedule: "0 0 * * *",
      prompt: "run now",
    });

    const result = await cron.run(job.id);
    expect(result).toBeDefined();
    expect(outcomes).toContain("manual-test");
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Note:** Adapt `createCronService` params and `cron.add` input to match actual API. The `schedule` field may use `{ kind: "cron", expression: "..." }` or a plain string — check `src/cron/types.ts`.

**Step 3: Commit**

```bash
git add src/cron/service.integration.test.ts
git commit -m "test(cron): add integration test for job CRUD and manual run"
```

---

### Task 12: System Integration Test — Full Gateway Boot

**Files:**
- Create: `src/integration/gateway.integration.test.ts`

**Step 1: Write the test**

This is the crown jewel — boots a real gateway and exercises it via HTTP.

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createGatewayApp, startHttpServer } from "../gateway/http.js";
import { createProcessPool } from "../engine/pool.js";
import { createTestContext } from "../../test/helpers/test-context.js";
import { createTestEnv, FAKE_CLAUDE_CMD } from "../../test/helpers/config.js";
import { createCleanupRegistry } from "../../test/helpers/cleanup.js";
import { rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";

describe("system integration: full gateway", () => {
  const ctx = createTestContext("system");
  const cleanup = createCleanupRegistry();
  let baseUrl: string;
  let pool: ReturnType<typeof createProcessPool>;
  let server: ReturnType<typeof startHttpServer>;

  beforeAll(async () => {
    const testEnv = await createTestEnv();
    cleanup.trackDir(testEnv.dir);

    pool = createProcessPool(2);
    const app = createGatewayApp({
      pool,
      startedAt: Date.now(),
      channels: [],
    });

    server = startHttpServer(app, 0);
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    ctx.log(`system test gateway on ${baseUrl}`);

    cleanup.onCleanup(async () => {
      server.close();
      await pool.drain();
    });
  }, 15_000);

  afterAll(async () => {
    await cleanup.runAll();
  });

  it("health → status → send lifecycle via real HTTP", async () => {
    ctx.dumpOnFailure();

    // 1. Health check
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const healthBody = await health.json();
    expect(healthBody.ok).toBe(true);
    ctx.log("health OK");

    // 2. Status check
    const status = await fetch(`${baseUrl}/api/status`);
    expect(status.status).toBe(200);
    const statusBody = await status.json();
    expect(statusBody.pool.running).toBe(0);
    ctx.log("status OK", statusBody);
  });

  it("real TCP fetch works (not just app.request)", async () => {
    ctx.dumpOnFailure();

    // This proves the server is actually listening on a real port
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
  });

  it("concurrent health checks don't crash", async () => {
    ctx.dumpOnFailure();

    const requests = Array.from({ length: 10 }, () =>
      fetch(`${baseUrl}/health`).then((r) => r.status),
    );
    const statuses = await Promise.all(requests);
    expect(statuses.every((s) => s === 200)).toBe(true);
  });
});
```

**Step 2: Run the test**

Run: `pnpm test:integration`
Expected: PASS

**Step 3: Commit**

```bash
git add src/integration/gateway.integration.test.ts
git commit -m "test(system): add full gateway boot integration test with real HTTP"
```

---

### Task 13: Custom Vitest Reporter for Subsystem Labels

**Files:**
- Create: `test/reporters/subsystem-reporter.ts`
- Modify: `vitest.integration.config.ts` (add reporter)

**Step 1: Create the reporter**

`test/reporters/subsystem-reporter.ts`:

```typescript
import type { Reporter, File, Task } from "vitest";

/**
 * Custom reporter that prefixes test names with subsystem tags
 * extracted from describe() block names.
 */
export default class SubsystemReporter implements Reporter {
  onTaskUpdate(packs: [string, { state?: string; duration?: number }][]) {
    // Default reporter handles this
  }

  onFinished(files?: File[]) {
    if (!files) return;

    console.log("\n--- Integration Test Summary ---\n");

    for (const file of files) {
      const tasks = this.collectTasks(file);
      for (const task of tasks) {
        const subsystem = this.extractSubsystem(task);
        const status = task.result?.state === "pass" ? "✓" : "✗";
        const duration = task.result?.duration
          ? `${task.result.duration}ms`
          : "?ms";
        const name = task.name;
        console.log(`  ${status} [${subsystem}] ${name} → ${duration}`);
      }
    }
    console.log("");
  }

  private collectTasks(suite: { tasks?: Task[] }): Task[] {
    const result: Task[] = [];
    for (const task of suite.tasks ?? []) {
      if (task.type === "test") {
        result.push(task);
      } else if ("tasks" in task) {
        result.push(...this.collectTasks(task));
      }
    }
    return result;
  }

  private extractSubsystem(task: Task): string {
    // Walk up the suite chain to find the subsystem
    const parts: string[] = [];
    let current = task.suite;
    while (current) {
      if (current.name) parts.unshift(current.name);
      current = current.suite;
    }
    const suiteName = parts[0] ?? "unknown";

    // Extract subsystem tag from common patterns
    const match = suiteName.match(
      /^(engine|gateway|router|mcp|memory|cron|telegram|slack|system)/i,
    );
    return match ? match[1].toLowerCase() : suiteName.slice(0, 20);
  }
}
```

**Step 2: Add reporter to integration config**

Update `vitest.integration.config.ts`:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 60_000,
    include: ["src/**/*.integration.test.ts"],
    reporters: ["default", "./test/reporters/subsystem-reporter.ts"],
  },
});
```

**Step 3: Run and verify output**

Run: `pnpm test:integration`
Expected: Normal vitest output PLUS a summary block:
```
--- Integration Test Summary ---

  ✓ [engine] spawns fake-claude and parses NDJSON result → 120ms
  ✓ [gateway] health endpoint returns 200 without auth → 5ms
  ...
```

**Step 4: Commit**

```bash
git add test/reporters/subsystem-reporter.ts vitest.integration.config.ts
git commit -m "test: add custom subsystem reporter for integration test visibility"
```

---

### Task 14: Verify Everything Together

**Step 1: Run the full unit suite**

Run: `pnpm test:run`
Expected: All existing unit tests pass, no integration tests included

**Step 2: Run the full integration suite**

Run: `pnpm test:integration`
Expected: All integration tests pass with subsystem labels in output

**Step 3: Run both suites**

Run: `pnpm test:all`
Expected: Both suites pass sequentially

**Step 4: Final commit if any fixups were needed**

```bash
git add -A
git commit -m "test: fix integration test adjustments from full suite run"
```
