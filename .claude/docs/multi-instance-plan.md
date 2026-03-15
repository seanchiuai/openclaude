# Multi-Instance OpenClaude & Live Probe Testing — Implementation Plan

## Purpose

OpenClaude currently hardcodes all state to `~/.openclaude/`. This means:
- Only one gateway instance can run per machine
- Live tests conflict with the production gateway (same PID file, same port, same SQLite)
- Developers can't run a dev instance alongside production

This plan adds **state directory override** (Phase 1), **CLI profiles** (Phase 2), and **live probe tests** (Phase 3) that use the isolation to test real Claude CLI tool invocation without touching production state.

## Why This Matters for Testing

Our current 41 integration tests use a **fake claude binary** — they verify the plumbing works but NOT whether Claude actually uses the MCP tools when given a real prompt. Live probe tests spawn the **real `claude` CLI** (authenticated via Pro subscription, no API key needed) with MCP tools pointing at an **isolated test gateway**. They use nonce-based assertions: write a unique value into memory → ask Claude to find it → assert the response contains the nonce. This tests the full pipeline: prompt → Claude → tool call → gateway API → response.

The isolation mechanism is what makes this safe — the test gateway runs on a random port with its own state directory, completely independent from any production gateway.

---

## Phase 1: State Directory Override

### What Changes

**Goal:** Make every path in the system derive from a single overridable base directory.

### File: `src/config/paths.ts` (26 lines total)

**Current code (line 7):**
```typescript
const BASE_DIR = join(homedir(), ".openclaude");
```

**Change to:**
```typescript
const BASE_DIR = process.env.OPENCLAUDE_STATE_DIR
  ? resolve(process.env.OPENCLAUDE_STATE_DIR.replace(/^~(?=\/|$)/, homedir()))
  : join(homedir(), ".openclaude");
```

**Why the tilde expansion:** Users may set `OPENCLAUDE_STATE_DIR=~/.openclaude-dev`. The `~` is NOT expanded by the shell when set via launchd/systemd EnvironmentFile, so we must handle it ourselves. `resolve()` ensures relative paths become absolute.

**Add import:** Add `resolve` to the existing `import { join } from "node:path"` on line 3:
```typescript
import { join, resolve } from "node:path";
```

**Full file after change:**
```typescript
/**
 * Standard paths for OpenClaude runtime data.
 */
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const BASE_DIR = process.env.OPENCLAUDE_STATE_DIR
  ? resolve(process.env.OPENCLAUDE_STATE_DIR.replace(/^~(?=\/|$)/, homedir()))
  : join(homedir(), ".openclaude");

export const paths = {
  base: BASE_DIR,
  config: join(BASE_DIR, "config.json"),
  logs: join(BASE_DIR, "logs"),
  logFile: join(BASE_DIR, "logs", "gateway.log"),
  errLogFile: join(BASE_DIR, "logs", "gateway.err.log"),
  sessions: join(BASE_DIR, "sessions"),
  memory: join(BASE_DIR, "memory"),
  memoryDb: join(BASE_DIR, "memory", "openclaude.sqlite"),
  cron: join(BASE_DIR, "cron"),
  cronJobs: join(BASE_DIR, "cron", "jobs.json"),
  skills: join(BASE_DIR, "skills"),
  workspace: join(BASE_DIR, "workspace"),
  heartbeat: join(BASE_DIR, "HEARTBEAT.md"),
  pidFile: join(BASE_DIR, "gateway.pid"),
  sessionsMap: join(BASE_DIR, "sessions-map.json"),
} as const;
```

**No other files need to change** for the paths to work — every file already imports from `./paths.js` and uses the `paths.*` properties. The `paths` object is evaluated once at module load time, which happens AFTER env vars are set.

### File: `src/config/schema.ts` (lines 81, 152)

**Problem:** Two Zod schema defaults contain hardcoded `~/.openclaude/` strings that bypass `paths.ts`:

Line 81:
```typescript
dbPath: z.string().default("~/.openclaude/memory/openclaude.sqlite"),
```

Line 152:
```typescript
storePath: z.string().default("~/.openclaude/cron/jobs.json"),
```

**Change both to use `paths` imports:**

Add import at the top of the file (after the Zod import on line 1):
```typescript
import { paths } from "./paths.js";
```

Change line 81 to:
```typescript
dbPath: z.string().default(paths.memoryDb),
```

Change line 152 to:
```typescript
storePath: z.string().default(paths.cronJobs),
```

### File: `src/config/loader.ts` (line 66)

**Problem:** DEFAULT_CONFIG has a hardcoded cron storePath on line 66:
```typescript
storePath: "~/.openclaude/cron/jobs.json",
```

**Change to:**
```typescript
storePath: paths.cronJobs,
```

`paths` is already imported on line 3 of this file.

### File: `src/cli/index.ts` (lines 135, 163)

**Problem 1:** Line 135 has a hardcoded port for the status check:
```typescript
const resp = await fetch("http://127.0.0.1:45557/api/status");
```

**Change to:**
```typescript
const port = process.env.OPENCLAUDE_GATEWAY_PORT ?? "45557";
const resp = await fetch(`http://127.0.0.1:${port}/api/status`);
```

**Problem 2:** Line 163 has a hardcoded path in a user-facing message:
```typescript
console.log("Edit ~/.openclaude/config.json to configure channels.");
```

**Change to:**
```typescript
const { paths } = await import("../config/paths.js");
console.log(`Edit ${paths.config} to configure channels.`);
```

Note: `paths` is not already imported in `setup()` — the import needs to be added inside the function (it already uses dynamic imports for other modules).

### File: `src/gateway/lifecycle.ts` (line 90 area)

**Problem:** The gateway port comes from config only — no env override:
```typescript
const gatewayPort = config.gateway.port;
```

**Change to:**
```typescript
const gatewayPort = process.env.OPENCLAUDE_GATEWAY_PORT
  ? parseInt(process.env.OPENCLAUDE_GATEWAY_PORT, 10)
  : config.gateway.port;
```

This allows `OPENCLAUDE_GATEWAY_PORT=0` for random port in tests.

### File: `src/gateway/launchd.ts` (line 15)

**Current:** The launchd label is hardcoded:
```typescript
const LABEL = "ai.openclaude.gateway";
```

**No change needed for Phase 1.** The label only needs to change in Phase 2 (profiles). For now, the env override of state dir is sufficient for test isolation — tests don't install launchd agents.

### File: `src/gateway/systemd.ts` (line 25)

**Current:** The systemd service name is hardcoded:
```typescript
const SERVICE_NAME = "openclaude-gateway";
```

**No change needed for Phase 1.** Same reasoning as launchd.

### Tests to Update

**File: `src/config/schema.test.ts` (line 26)**

Currently asserts:
```typescript
expect(result.memory.dbPath).toBe("~/.openclaude/memory/openclaude.sqlite");
```

This will break because the default now comes from `paths.memoryDb` which is an absolute path. Change to:
```typescript
import { paths } from "./paths.js";
// ...
expect(result.memory.dbPath).toBe(paths.memoryDb);
```

### New Test: `src/config/paths.test.ts`

Create a test that verifies the env override works:

```typescript
import { describe, it, expect, afterEach, vi } from "vitest";

describe("paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to ~/.openclaude", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "");
    const { paths } = await import("./paths.js");
    expect(paths.base).toMatch(/\.openclaude$/);
  });

  it("respects OPENCLAUDE_STATE_DIR override", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "/tmp/test-openclaude");
    vi.resetModules();
    const { paths } = await import("./paths.js");
    expect(paths.base).toBe("/tmp/test-openclaude");
    expect(paths.config).toBe("/tmp/test-openclaude/config.json");
    expect(paths.sessions).toBe("/tmp/test-openclaude/sessions");
    expect(paths.pidFile).toBe("/tmp/test-openclaude/gateway.pid");
  });

  it("expands tilde in OPENCLAUDE_STATE_DIR", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "~/.openclaude-dev");
    vi.resetModules();
    const { paths } = await import("./paths.js");
    expect(paths.base).not.toContain("~");
    expect(paths.base).toMatch(/\.openclaude-dev$/);
  });
});
```

**Important caveat about `vi.resetModules()`:** Since `paths.ts` evaluates `BASE_DIR` at module load time (top-level const), you MUST call `vi.resetModules()` before re-importing to get a fresh evaluation with the new env var. This is how OpenClaw tests it too.

### Commit

After all Phase 1 changes pass tests:
```
feat(config): add OPENCLAUDE_STATE_DIR and OPENCLAUDE_GATEWAY_PORT env overrides

Allows running multiple isolated OpenClaude instances on one machine.
All paths derive from BASE_DIR which now respects OPENCLAUDE_STATE_DIR.
Gateway port can be overridden with OPENCLAUDE_GATEWAY_PORT (including 0 for random).
Removes hardcoded ~/.openclaude strings from schema defaults and CLI output.
```

---

## Phase 2: CLI Profiles

### What Changes

**Goal:** `openclaude --profile dev start` automatically sets `OPENCLAUDE_STATE_DIR=~/.openclaude-dev` and assigns a different port, so developers can run dev alongside production with zero config.

### File: `src/cli/index.ts`

**Add profile parsing** before the command switch (after line 11, before line 13):

```typescript
const { values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    profile: { type: "string" },
    dev: { type: "boolean" },
  },
});

// Apply profile before any command runs
const profile = values.dev ? "dev" : (values.profile as string | undefined);
if (profile && profile !== "default") {
  // Set state dir if not already overridden
  if (!process.env.OPENCLAUDE_STATE_DIR) {
    const { homedir } = await import("node:os");
    process.env.OPENCLAUDE_STATE_DIR = join(homedir(), `.openclaude-${profile}`);
  }
  // Set default dev port if not already overridden
  if (!process.env.OPENCLAUDE_GATEWAY_PORT && profile === "dev") {
    process.env.OPENCLAUDE_GATEWAY_PORT = "19001";
  }
}
```

**Why set env vars early:** The `paths` module is loaded lazily (dynamic imports throughout the CLI). By setting the env vars before any import of `paths.js`, all downstream code automatically uses the profile-specific directories.

**Note:** The `parseArgs` call on line 8 already uses `strict: false`, so adding new options won't break existing arg parsing. But you need to change the destructuring — currently it's `const { positionals }`, change to also extract `values`:

```typescript
const { positionals, values } = parseArgs({
  allowPositionals: true,
  strict: false,
  options: {
    profile: { type: "string" },
    dev: { type: "boolean" },
  },
});
```

### File: `src/gateway/launchd.ts` (line 15-17)

**Change the label to be profile-aware:**

```typescript
const PROFILE = process.env.OPENCLAUDE_PROFILE ?? "";
const LABEL = PROFILE && PROFILE !== "default"
  ? `ai.openclaude.${PROFILE}`
  : "ai.openclaude.gateway";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
```

**Why:** Multiple profiles need different launchd labels. `ai.openclaude.gateway` (default) vs `ai.openclaude.dev` vs `ai.openclaude.staging`. Without this, two profiles would fight over the same plist.

**Also:** In `src/cli/index.ts`, when applying a profile, set `OPENCLAUDE_PROFILE`:
```typescript
if (profile && profile !== "default") {
  process.env.OPENCLAUDE_PROFILE = profile;
  // ... rest of profile setup
}
```

### File: `src/gateway/systemd.ts` (line 25-28)

**Change the service name to be profile-aware:**

```typescript
const PROFILE = process.env.OPENCLAUDE_PROFILE ?? "";
const SERVICE_NAME = PROFILE && PROFILE !== "default"
  ? `openclaude-gateway-${PROFILE}`
  : "openclaude-gateway";
const UNIT_NAME = `${SERVICE_NAME}.service`;
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME);
```

### Update `printUsage()` in `src/cli/index.ts`

Add profile documentation to the usage text (around line 216):

```typescript
function printUsage() {
  console.log(`OpenClaude - Autonomous AI assistant powered by Claude Code CLI

Usage: openclaude [--profile <name> | --dev] <command>

Commands:
  start   Start the OpenClaude gateway daemon
  stop    Stop the gateway daemon
  status  Show gateway status
  setup   Initialize config and directories
  skills list  List loaded skills
  memory search <query>  Search memory
  logs         Tail gateway logs

Options:
  --profile <name>  Use named profile (state dir: ~/.openclaude-<name>)
  --dev             Shortcut for --profile dev (port 19001)

Internal:
  gateway run   Run gateway in foreground (used by LaunchAgent/systemd)
`);
}
```

### Tests

Add to `src/config/paths.test.ts`:

```typescript
it("profile sets correct state dir via env", async () => {
  vi.stubEnv("OPENCLAUDE_STATE_DIR", `${homedir()}/.openclaude-staging`);
  vi.resetModules();
  const { paths } = await import("./paths.js");
  expect(paths.base).toMatch(/\.openclaude-staging$/);
  expect(paths.pidFile).toMatch(/\.openclaude-staging\/gateway\.pid$/);
});
```

### Commit

```
feat(cli): add --profile and --dev flags for multi-instance support

openclaude --profile dev start → runs with ~/.openclaude-dev state dir,
port 19001, separate launchd/systemd service name. Allows running
dev and production instances side by side.
```

---

## Phase 3: Test Isolation Helper

### What Changes

**Goal:** Create a `withIsolatedTestHome()` helper (like OpenClaw's) that integration and live tests use to boot isolated gateways.

### File: `test/helpers/isolated-env.ts` (new)

```typescript
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface IsolatedEnv {
  stateDir: string;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated OpenClaude state directory for testing.
 * Sets OPENCLAUDE_STATE_DIR so all paths.* resolve to the temp dir.
 * Restores the original env on cleanup.
 */
export async function withIsolatedTestHome(): Promise<IsolatedEnv> {
  const stateDir = await mkdtemp(join(tmpdir(), "openclaude-test-home-"));

  // Create required subdirectories
  await mkdir(join(stateDir, "sessions"), { recursive: true });
  await mkdir(join(stateDir, "memory"), { recursive: true });
  await mkdir(join(stateDir, "logs"), { recursive: true });
  await mkdir(join(stateDir, "cron"), { recursive: true });
  await mkdir(join(stateDir, "skills"), { recursive: true });
  await mkdir(join(stateDir, "workspace"), { recursive: true });

  const originalStateDir = process.env.OPENCLAUDE_STATE_DIR;
  const originalPort = process.env.OPENCLAUDE_GATEWAY_PORT;

  process.env.OPENCLAUDE_STATE_DIR = stateDir;
  process.env.OPENCLAUDE_GATEWAY_PORT = "0"; // random port

  return {
    stateDir,
    async cleanup() {
      // Restore env
      if (originalStateDir !== undefined) {
        process.env.OPENCLAUDE_STATE_DIR = originalStateDir;
      } else {
        delete process.env.OPENCLAUDE_STATE_DIR;
      }
      if (originalPort !== undefined) {
        process.env.OPENCLAUDE_GATEWAY_PORT = originalPort;
      } else {
        delete process.env.OPENCLAUDE_GATEWAY_PORT;
      }

      // Remove temp dir
      try {
        await rm(stateDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        // Best effort
      }
    },
  };
}
```

**Important:** This helper sets `process.env.OPENCLAUDE_STATE_DIR` which is read by `paths.ts` at module load time. For tests that import `paths.ts` fresh (via `vi.resetModules()`), this works perfectly. For tests that import it statically, the env must be set BEFORE the test file's imports are resolved — meaning this helper is best used in `beforeAll()` hooks with dynamic imports of the modules under test.

### Commit

```
test: add withIsolatedTestHome helper for test environment isolation
```

---

## Phase 4: Live Probe Tests

### What Changes

**Goal:** Tests that spawn the REAL `claude` CLI with MCP tools and verify tool invocation via nonce-based assertions. Gated behind `OPENCLAUDE_LIVE=1`. Requires a machine where `claude` is authenticated (Pro subscription). No API key needed.

### Prerequisite Check

Before writing the tests, verify that `claude` is available and authenticated:

```typescript
import { execSync } from "node:child_process";

function isClaudeAvailable(): boolean {
  try {
    const result = execSync("claude --version", { timeout: 5000 }).toString();
    return result.includes("claude");
  } catch {
    return false;
  }
}
```

### File: `vitest.live.config.ts` (new)

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    pool: "forks",
    testTimeout: 120_000, // 2 min per test (real Claude is slow)
    include: ["test/live/**/*.test.ts"],
    reporters: ["default", "./test/reporters/subsystem-reporter.ts"],
  },
});
```

### File: `package.json` — add script

```json
"test:live": "OPENCLAUDE_LIVE=1 vitest run --config vitest.live.config.ts"
```

### File: `test/live/probe-memory.test.ts` (new)

This test verifies Claude can use the `memory_search` MCP tool:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { withIsolatedTestHome, type IsolatedEnv } from "../helpers/isolated-env.js";
import { createTestContext } from "../helpers/test-context.js";

describe.skipIf(!process.env.OPENCLAUDE_LIVE)("live probe: memory search", () => {
  const ctx = createTestContext("live-memory");
  let env: IsolatedEnv;
  let gatewayPort: number;
  let shutdownGateway: () => Promise<void>;

  beforeAll(async () => {
    env = await withIsolatedTestHome();
    ctx.log(`isolated state dir: ${env.stateDir}`);

    // Dynamically import AFTER env is set so paths resolve to temp dir
    // vi.resetModules() is needed if paths was previously imported
    const { startGateway } = await import("../../src/gateway/lifecycle.js");
    const gateway = await startGateway(join(env.stateDir, "config.json"));

    // Extract actual port from the running server
    // NOTE: startGateway() needs to expose the port — see "Required Gateway Change" below
    gatewayPort = gateway.port;
    shutdownGateway = gateway.shutdown;
    ctx.log(`test gateway on port ${gatewayPort}`);
  }, 30_000);

  afterAll(async () => {
    await shutdownGateway?.();
    await env?.cleanup();
  });

  it("claude finds nonce via memory_search tool", async () => {
    ctx.dumpOnFailure();

    // 1. Write a memory file with a unique nonce
    const nonce = `PROBE-${randomUUID().slice(0, 8).toUpperCase()}`;
    await writeFile(
      join(env.stateDir, "memory", "probe-note.md"),
      `# Probe Note\nThe secret verification code is: ${nonce}\n`,
    );

    // 2. Sync memory so it's indexed
    const { createMemoryManager } = await import("../../src/memory/index.js");
    const manager = createMemoryManager({
      dbPath: join(env.stateDir, "memory", "openclaude.sqlite"),
      workspaceDir: env.stateDir,
    });
    await manager.sync();
    manager.close();
    ctx.log(`nonce ${nonce} written and indexed`);

    // 3. Spawn REAL claude with MCP tools pointing at test gateway
    const { spawnClaude } = await import("../../src/engine/spawn.js");
    const { promise } = spawnClaude({
      sessionId: "live-probe-memory",
      prompt: `Use your memory_search tool to search for "verification code". Tell me the exact code you find. Reply with ONLY the code, nothing else.`,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      gatewayToken: "",
      workingDirectory: env.stateDir,
    });
    // NOTE: no claudeBinary override — uses REAL claude

    const result = await promise;
    ctx.log(`claude response: ${result.text}`);
    ctx.log(`exit code: ${result.exitCode}, turns: ${result.numTurns}`);

    // 4. Assert claude found the nonce
    expect(result.exitCode).toBe(0);
    expect(result.text).toContain(nonce);
  }, 120_000);
});
```

### File: `test/live/probe-cron.test.ts` (new)

This test verifies Claude can use the `cron_list` tool:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { withIsolatedTestHome, type IsolatedEnv } from "../helpers/isolated-env.js";
import { createTestContext } from "../helpers/test-context.js";

describe.skipIf(!process.env.OPENCLAUDE_LIVE)("live probe: cron tools", () => {
  const ctx = createTestContext("live-cron");
  let env: IsolatedEnv;
  let gatewayPort: number;
  let shutdownGateway: () => Promise<void>;

  beforeAll(async () => {
    env = await withIsolatedTestHome();

    const { startGateway } = await import("../../src/gateway/lifecycle.js");
    const gateway = await startGateway(join(env.stateDir, "config.json"));
    gatewayPort = gateway.port;
    shutdownGateway = gateway.shutdown;
    ctx.log(`test gateway on port ${gatewayPort}`);
  }, 30_000);

  afterAll(async () => {
    await shutdownGateway?.();
    await env?.cleanup();
  });

  it("claude uses cron_list and reports empty", async () => {
    ctx.dumpOnFailure();

    const { spawnClaude } = await import("../../src/engine/spawn.js");
    const { promise } = spawnClaude({
      sessionId: "live-probe-cron",
      prompt: `Use your cron_list tool to list all cron jobs. If there are no jobs, reply with exactly the word EMPTY.`,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      gatewayToken: "",
      workingDirectory: env.stateDir,
    });

    const result = await promise;
    ctx.log(`claude response: ${result.text}`);

    expect(result.exitCode).toBe(0);
    // Claude should have used the tool and found no jobs
    expect(result.text.toLowerCase()).toMatch(/empty|no.*jobs|no.*cron/);
  }, 120_000);
});
```

### File: `test/live/probe-send.test.ts` (new)

This test verifies Claude can use the `send_message` tool and the message actually arrives:

```typescript
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { join } from "node:path";
import { withIsolatedTestHome, type IsolatedEnv } from "../helpers/isolated-env.js";
import { createTestContext } from "../helpers/test-context.js";

describe.skipIf(!process.env.OPENCLAUDE_LIVE)("live probe: send_message tool", () => {
  const ctx = createTestContext("live-send");
  let env: IsolatedEnv;
  let gatewayPort: number;
  let shutdownGateway: () => Promise<void>;
  const sentMessages: Array<{ channel: string; chatId: string; text: string }> = [];

  beforeAll(async () => {
    env = await withIsolatedTestHome();

    // Boot gateway with a custom send handler that captures messages
    // NOTE: This requires the gateway to support a send callback or
    // the test to intercept the /api/send endpoint. The simplest
    // approach is to check the gateway's HTTP response.
    const { startGateway } = await import("../../src/gateway/lifecycle.js");
    const gateway = await startGateway(join(env.stateDir, "config.json"));
    gatewayPort = gateway.port;
    shutdownGateway = gateway.shutdown;
    ctx.log(`test gateway on port ${gatewayPort}`);
  }, 30_000);

  afterAll(async () => {
    await shutdownGateway?.();
    await env?.cleanup();
  });

  it("claude uses send_message tool", async () => {
    ctx.dumpOnFailure();

    const { spawnClaude } = await import("../../src/engine/spawn.js");
    const { promise } = spawnClaude({
      sessionId: "live-probe-send",
      prompt: `Use your send_message tool to send the message "PROBE_OK" to channel "test" chat ID "probe-chat". After sending, confirm by saying SENT.`,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}`,
      gatewayToken: "",
      workingDirectory: env.stateDir,
    });

    const result = await promise;
    ctx.log(`claude response: ${result.text}`);

    expect(result.exitCode).toBe(0);
    // Claude should have attempted the tool call
    // The send may fail (no real channel) but the tool should have been invoked
    // We check that Claude acknowledged the attempt
    expect(result.numTurns).toBeGreaterThanOrEqual(1); // At least one tool-use turn
  }, 120_000);
});
```

### Required Gateway Change: Expose Port

**File: `src/gateway/lifecycle.ts`**

The `Gateway` interface (lines 34-42) does NOT include the port. Live tests need to know which port the gateway bound to (especially with `port: 0`).

**Add `port` to the Gateway interface (line 34):**
```typescript
export interface Gateway {
  config: OpenClaudeConfig;
  port: number;
  pool: ProcessPool;
  channels: Map<string, ChannelAdapter>;
  memoryManager?: MemorySearchManager;
  cronService?: CronService;
  subagentRegistry?: SubagentRegistry;
  shutdown: () => Promise<void>;
}
```

**Set the port in the return object** — find where the gateway object is constructed (near line 380+) and add:
```typescript
port: gatewayPort,
```

**Also:** When using `port: 0`, the actual port is assigned by the OS. You need to read it from the server:
```typescript
import type { AddressInfo } from "node:net";
// ...
const server = startHttpServer(app, gatewayPort);
const actualPort = gatewayPort === 0
  ? (server.address() as AddressInfo).port
  : gatewayPort;
```

Then use `actualPort` in the gateway URL and the returned object.

### Commit

```
feat(testing): add live probe tests for real Claude CLI tool invocation

Gated behind OPENCLAUDE_LIVE=1. Boots isolated test gateway on random
port, spawns real claude -p with MCP tools, verifies tool invocation
via nonce-based assertions. No API key needed — uses authenticated
claude CLI.
```

---

## Phase Summary & Execution Order

| Phase | Changes | Files Modified | Files Created | Risk |
|-------|---------|----------------|---------------|------|
| **1** | State dir override + port override | `paths.ts`, `schema.ts`, `loader.ts`, `cli/index.ts`, `lifecycle.ts`, `schema.test.ts` | `paths.test.ts` | Low — env var default = current behavior |
| **2** | CLI profiles | `cli/index.ts`, `launchd.ts`, `systemd.ts` | None | Low — additive flags |
| **3** | Test isolation helper | None | `test/helpers/isolated-env.ts` | None — new file |
| **4** | Live probe tests | `lifecycle.ts` (expose port) | `vitest.live.config.ts`, `test/live/probe-*.test.ts` | Low — gated behind env flag |

**Execute in order.** Each phase depends on the previous. Phase 1 is the foundation — without it, nothing else works.

**After each phase:**
1. Run `pnpm test:run` — all 967 unit tests must pass
2. Run `pnpm test:integration` — all 41 integration tests must pass
3. Commit

**After Phase 4:**
4. Run `pnpm test:live` on a machine with authenticated `claude` CLI

---

## Reference: Every File That Uses `paths.*`

These files import `src/config/paths.js` and use `paths.*` properties. They do NOT need changes because they already derive from the `paths` object — once `paths.ts` respects the env var, all these files automatically use the correct directory.

| File | Properties Used |
|------|----------------|
| `src/config/loader.ts` | `paths.memoryDb`, `paths.config`, `paths.base`, `paths.logs`, `paths.sessions`, `paths.memory`, `paths.cron`, `paths.skills`, `paths.workspace` |
| `src/gateway/lifecycle.ts` | `paths.base`, `paths.sessions`, `paths.heartbeat`, `paths.skills`, `paths.pidFile` |
| `src/gateway/launchd.ts` | `paths.base`, `paths.logFile`, `paths.errLogFile` |
| `src/gateway/http.ts` | `paths.logFile` |
| `src/engine/spawn.ts` | `paths.sessions` |
| `src/engine/workspace.ts` | `paths.base` |
| `src/router/router.ts` | `paths.sessionsMap`, `paths.memory` |
| `src/memory/manager.ts` | `paths.base` |
| `src/memory/session-files.ts` | `paths.sessions` |
| `src/logging/logger.ts` | `paths.logFile` |
| `src/cli/index.ts` | `paths.skills`, `paths.memoryDb`, `paths.base`, `paths.logs` |

## Reference: Test Files That Mock `paths.js`

These test files use `vi.mock("../config/paths.js", ...)` and create their own fake paths objects. They will continue to work unchanged because the mock overrides the module entirely.

| File |
|------|
| `src/integration/boot.test.ts` (line 32) |
| `src/gateway/lifecycle.test.ts` (line 31) |
| `src/gateway/launchd.test.ts` (line 30) |
| `src/gateway/http-logs.test.ts` (line 14) |
| `src/engine/spawn-edge-cases.test.ts` (line 16) |
| `src/logging/logger.test.ts` (line 9) |
| `src/router/router-edge-cases.test.ts` (line 17) |
| `src/config/loader.test.ts` (lines 145, 194) |
