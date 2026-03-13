# Zombie Process Prevention & Config Env Var Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix two production-reliability issues: (1) orphaned zombie processes when the gateway crashes, and (2) env var substitution crashing on disabled channels with missing env vars.

**Architecture:** Copy OpenClaw's battle-tested patterns. The orphan reaper uses `lsof` to find stale processes on the gateway port at startup and kills them. The env var system collects warnings for missing vars instead of throwing, then only errors for enabled channels.

**Tech Stack:** Node.js child_process (spawnSync), Atomics.wait for synchronous sleep, Zod for validation, vitest for tests.

---

### Task 1: Replace env-substitution.ts with OpenClaw's lenient implementation

**Files:**
- Rewrite: `src/config/env-substitution.ts`
- Test: `src/config/env-substitution.test.ts`

**Step 1: Write the failing tests**

Replace `src/config/env-substitution.test.ts` with tests ported from OpenClaw's test suite. These test the new API (`resolveConfigEnvVars`, `containsEnvVarReference`, `MissingEnvVarError`, `onMissing` callback):

```typescript
import { describe, it, expect } from "vitest";
import {
  type EnvSubstitutionWarning,
  MissingEnvVarError,
  containsEnvVarReference,
  resolveConfigEnvVars,
} from "./env-substitution.js";

type SubstitutionScenario = {
  name: string;
  config: unknown;
  env: Record<string, string>;
  expected: unknown;
};

type MissingEnvScenario = {
  name: string;
  config: unknown;
  env: Record<string, string>;
  varName: string;
  configPath: string;
};

function expectResolvedScenarios(scenarios: SubstitutionScenario[]) {
  for (const scenario of scenarios) {
    const result = resolveConfigEnvVars(scenario.config, scenario.env as unknown as NodeJS.ProcessEnv);
    expect(result, scenario.name).toEqual(scenario.expected);
  }
}

function expectMissingScenarios(scenarios: MissingEnvScenario[]) {
  for (const scenario of scenarios) {
    try {
      resolveConfigEnvVars(scenario.config, scenario.env as unknown as NodeJS.ProcessEnv);
      expect.fail(`${scenario.name}: expected MissingEnvVarError`);
    } catch (err) {
      expect(err, scenario.name).toBeInstanceOf(MissingEnvVarError);
      const error = err as MissingEnvVarError;
      expect(error.varName, scenario.name).toBe(scenario.varName);
      expect(error.configPath, scenario.name).toBe(scenario.configPath);
    }
  }
}

describe("resolveConfigEnvVars", () => {
  describe("basic substitution", () => {
    it("substitutes direct, inline, repeated, and multi-var patterns", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "single env var",
          config: { key: "${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "bar" },
        },
        {
          name: "multiple env vars in same string",
          config: { key: "${A}/${B}" },
          env: { A: "x", B: "y" },
          expected: { key: "x/y" },
        },
        {
          name: "inline prefix/suffix",
          config: { key: "prefix-${FOO}-suffix" },
          env: { FOO: "bar" },
          expected: { key: "prefix-bar-suffix" },
        },
        {
          name: "same var repeated",
          config: { key: "${FOO}:${FOO}" },
          env: { FOO: "bar" },
          expected: { key: "bar:bar" },
        },
      ];
      expectResolvedScenarios(scenarios);
    });
  });

  describe("nested structures", () => {
    it("substitutes variables in nested objects and arrays", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "nested object",
          config: { outer: { inner: { key: "${API_KEY}" } } },
          env: { API_KEY: "secret123" },
          expected: { outer: { inner: { key: "secret123" } } },
        },
        {
          name: "flat array",
          config: { items: ["${A}", "${B}", "${C}"] },
          env: { A: "1", B: "2", C: "3" },
          expected: { items: ["1", "2", "3"] },
        },
      ];
      expectResolvedScenarios(scenarios);
    });
  });

  describe("missing env var handling", () => {
    it("throws MissingEnvVarError with var name and config path", () => {
      const scenarios: MissingEnvScenario[] = [
        {
          name: "missing top-level var",
          config: { key: "${MISSING}" },
          env: {},
          varName: "MISSING",
          configPath: "key",
        },
        {
          name: "missing nested var",
          config: { outer: { inner: { key: "${MISSING_VAR}" } } },
          env: {},
          varName: "MISSING_VAR",
          configPath: "outer.inner.key",
        },
        {
          name: "missing var in array element",
          config: { items: ["ok", "${MISSING}"] },
          env: {},
          varName: "MISSING",
          configPath: "items[1]",
        },
        {
          name: "empty string env value treated as missing",
          config: { key: "${EMPTY}" },
          env: { EMPTY: "" },
          varName: "EMPTY",
          configPath: "key",
        },
      ];
      expectMissingScenarios(scenarios);
    });
  });

  describe("escape syntax", () => {
    it("handles escaped placeholders", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "escaped placeholder stays literal",
          config: { key: "$${VAR}" },
          env: { VAR: "value" },
          expected: { key: "${VAR}" },
        },
        {
          name: "mix of escaped and unescaped",
          config: { key: "${REAL}/$${LITERAL}" },
          env: { REAL: "resolved" },
          expected: { key: "resolved/${LITERAL}" },
        },
      ];
      expectResolvedScenarios(scenarios);
    });
  });

  describe("pattern matching rules", () => {
    it("leaves non-matching placeholders unchanged", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "$VAR (no braces) is not matched",
          config: { key: "$VAR" },
          env: { VAR: "value" },
          expected: { key: "$VAR" },
        },
        {
          name: "lowercase placeholder not matched",
          config: { key: "${lowercase}" },
          env: { lowercase: "value" },
          expected: { key: "${lowercase}" },
        },
      ];
      expectResolvedScenarios(scenarios);
    });

    it("substitutes valid uppercase/underscore names", () => {
      const scenarios: SubstitutionScenario[] = [
        {
          name: "underscore-prefixed",
          config: { key: "${_UNDERSCORE_START}" },
          env: { _UNDERSCORE_START: "valid" },
          expected: { key: "valid" },
        },
        {
          name: "name with numbers",
          config: { key: "${VAR_123}" },
          env: { VAR_123: "valid" },
          expected: { key: "valid" },
        },
      ];
      expectResolvedScenarios(scenarios);
    });
  });

  describe("passthrough behavior", () => {
    it("passes through primitives unchanged", () => {
      for (const value of ["hello", 42, true, null]) {
        expect(resolveConfigEnvVars(value, {} as NodeJS.ProcessEnv)).toBe(value);
      }
    });
  });

  describe("graceful missing env var handling (onMissing)", () => {
    it("collects warnings and preserves placeholder when onMissing is set", () => {
      const warnings: EnvSubstitutionWarning[] = [];
      const result = resolveConfigEnvVars(
        { key: "${MISSING_VAR}", present: "${PRESENT}" },
        { PRESENT: "ok" } as unknown as NodeJS.ProcessEnv,
        { onMissing: (w) => warnings.push(w) },
      );
      expect(result).toEqual({ key: "${MISSING_VAR}", present: "ok" });
      expect(warnings).toEqual([{ varName: "MISSING_VAR", configPath: "key" }]);
    });

    it("collects multiple warnings across nested paths", () => {
      const warnings: EnvSubstitutionWarning[] = [];
      resolveConfigEnvVars(
        {
          channels: {
            telegram: { botToken: "${TG_TOKEN}" },
            slack: { botToken: "${SLACK_TOKEN}" },
          },
        },
        {} as NodeJS.ProcessEnv,
        { onMissing: (w) => warnings.push(w) },
      );
      expect(warnings).toHaveLength(2);
      expect(warnings[0]).toEqual({ varName: "TG_TOKEN", configPath: "channels.telegram.botToken" });
      expect(warnings[1]).toEqual({ varName: "SLACK_TOKEN", configPath: "channels.slack.botToken" });
    });

    it("still throws when onMissing is not set", () => {
      expect(() =>
        resolveConfigEnvVars({ key: "${MISSING}" }, {} as NodeJS.ProcessEnv),
      ).toThrow(MissingEnvVarError);
    });
  });

  describe("containsEnvVarReference", () => {
    it("detects unresolved env var placeholders", () => {
      expect(containsEnvVarReference("${FOO}")).toBe(true);
      expect(containsEnvVarReference("prefix-${VAR}-suffix")).toBe(true);
    });

    it("returns false for non-matching patterns", () => {
      expect(containsEnvVarReference("no-refs-here")).toBe(false);
      expect(containsEnvVarReference("$VAR")).toBe(false);
      expect(containsEnvVarReference("${lowercase}")).toBe(false);
      expect(containsEnvVarReference("")).toBe(false);
    });

    it("returns false for escaped placeholders", () => {
      expect(containsEnvVarReference("$${ESCAPED}")).toBe(false);
    });

    it("detects references mixed with escaped placeholders", () => {
      expect(containsEnvVarReference("$${ESCAPED} ${REAL}")).toBe(true);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/config/env-substitution.test.ts`
Expected: FAIL — `resolveConfigEnvVars`, `MissingEnvVarError`, `containsEnvVarReference` don't exist yet.

**Step 3: Write the implementation**

Replace `src/config/env-substitution.ts` with OpenClaw's implementation, adapted (no `isPlainObject` import — inline the check):

```typescript
/**
 * Environment variable substitution for config values.
 * Adapted from OpenClaw's config/env-substitution.ts.
 *
 * Supports ${VAR_NAME} syntax. Only uppercase env var names are matched.
 * Escape with $${VAR} to output literal ${VAR}.
 * Missing vars throw MissingEnvVarError unless onMissing callback is provided.
 */

const ENV_VAR_NAME_PATTERN = /^[A-Z_][A-Z0-9_]*$/;

export class MissingEnvVarError extends Error {
  constructor(
    public readonly varName: string,
    public readonly configPath: string,
  ) {
    super(`Missing env var "${varName}" referenced at config path: ${configPath}`);
    this.name = "MissingEnvVarError";
  }
}

type EnvToken =
  | { kind: "escaped"; name: string; end: number }
  | { kind: "substitution"; name: string; end: number };

function parseEnvTokenAt(value: string, index: number): EnvToken | null {
  if (value[index] !== "$") return null;

  const next = value[index + 1];
  const afterNext = value[index + 2];

  // Escaped: $${VAR} -> ${VAR}
  if (next === "$" && afterNext === "{") {
    const start = index + 3;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "escaped", name, end };
      }
    }
  }

  // Substitution: ${VAR} -> value
  if (next === "{") {
    const start = index + 2;
    const end = value.indexOf("}", start);
    if (end !== -1) {
      const name = value.slice(start, end);
      if (ENV_VAR_NAME_PATTERN.test(name)) {
        return { kind: "substitution", name, end };
      }
    }
  }

  return null;
}

export type EnvSubstitutionWarning = {
  varName: string;
  configPath: string;
};

export type SubstituteOptions = {
  /** When set, missing vars call this instead of throwing and the original placeholder is preserved. */
  onMissing?: (warning: EnvSubstitutionWarning) => void;
};

function substituteString(
  value: string,
  env: NodeJS.ProcessEnv,
  configPath: string,
  opts?: SubstituteOptions,
): string {
  if (!value.includes("$")) return value;

  const chunks: string[] = [];

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (char !== "$") {
      chunks.push(char);
      continue;
    }

    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      chunks.push(`\${${token.name}}`);
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") {
      const envValue = env[token.name];
      if (envValue === undefined || envValue === "") {
        if (opts?.onMissing) {
          opts.onMissing({ varName: token.name, configPath });
          chunks.push(`\${${token.name}}`);
          i = token.end;
          continue;
        }
        throw new MissingEnvVarError(token.name, configPath);
      }
      chunks.push(envValue);
      i = token.end;
      continue;
    }

    chunks.push(char);
  }

  return chunks.join("");
}

export function containsEnvVarReference(value: string): boolean {
  if (!value.includes("$")) return false;

  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== "$") continue;
    const token = parseEnvTokenAt(value, i);
    if (token?.kind === "escaped") {
      i = token.end;
      continue;
    }
    if (token?.kind === "substitution") return true;
  }

  return false;
}

function substituteAny(
  value: unknown,
  env: NodeJS.ProcessEnv,
  path: string,
  opts?: SubstituteOptions,
): unknown {
  if (typeof value === "string") return substituteString(value, env, path, opts);

  if (Array.isArray(value)) {
    return value.map((item, index) => substituteAny(item, env, `${path}[${index}]`, opts));
  }

  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      result[key] = substituteAny(val, env, childPath, opts);
    }
    return result;
  }

  return value;
}

/**
 * Resolves ${VAR_NAME} environment variable references in config values.
 */
export function resolveConfigEnvVars(
  obj: unknown,
  env: NodeJS.ProcessEnv = process.env,
  opts?: SubstituteOptions,
): unknown {
  return substituteAny(obj, env, "", opts);
}
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/config/env-substitution.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/config/env-substitution.ts src/config/env-substitution.test.ts
git commit -m "feat: replace env-substitution with OpenClaw's lenient implementation

Adds onMissing callback, MissingEnvVarError with config path,
containsEnvVarReference helper, escape syntax, uppercase-only matching."
```

---

### Task 2: Update config loader to use lenient substitution

**Files:**
- Modify: `src/config/loader.ts`
- Modify: `src/config/loader.test.ts`
- Modify: `src/config/config-edge-cases.test.ts`

**Step 1: Write the failing tests**

Add tests to `src/config/loader.test.ts`:

```typescript
it("loads config with disabled channel missing env var (warning only)", () => {
  const configPath = join(TEST_DIR, "config.json");
  // No TELEGRAM_BOT_TOKEN set in env

  writeFileSync(
    configPath,
    JSON.stringify({
      channels: {
        telegram: {
          enabled: false,
          botToken: "${TELEGRAM_BOT_TOKEN}",
        },
      },
    }),
  );

  // Should NOT throw — channel is disabled
  const config = loadConfig(configPath);
  expect(config.channels.telegram?.enabled).toBe(false);
});

it("throws for enabled channel with missing env var", () => {
  const configPath = join(TEST_DIR, "config.json");
  // No TELEGRAM_BOT_TOKEN set in env

  writeFileSync(
    configPath,
    JSON.stringify({
      channels: {
        telegram: {
          enabled: true,
          botToken: "${TELEGRAM_BOT_TOKEN}",
        },
      },
    }),
  );

  expect(() => loadConfig(configPath)).toThrow(/TELEGRAM_BOT_TOKEN/);
});

it("substitutes env vars using ${VAR} syntax", () => {
  const configPath = join(TEST_DIR, "config.json");
  process.env.TEST_BOT_TOKEN_BRACED = "braced-token";

  writeFileSync(
    configPath,
    JSON.stringify({
      channels: {
        telegram: {
          enabled: true,
          botToken: "${TEST_BOT_TOKEN_BRACED}",
        },
      },
    }),
  );

  const config = loadConfig(configPath);
  expect(config.channels.telegram?.botToken).toBe("braced-token");

  delete process.env.TEST_BOT_TOKEN_BRACED;
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/config/loader.test.ts`
Expected: FAIL — disabled channel with missing env var throws, and the import of `substituteEnvVarsDeep` is broken.

**Step 3: Update loader.ts**

Replace the import and `loadConfig` function:

```typescript
import { resolveConfigEnvVars, containsEnvVarReference } from "./env-substitution.js";
import type { EnvSubstitutionWarning } from "./env-substitution.js";
```

Replace the `loadConfig` body:

```typescript
export function loadConfig(configPath?: string): OpenClaudeConfig {
  const filePath = configPath ?? paths.config;

  if (!existsSync(filePath)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  // Substitute env vars leniently — collect warnings instead of throwing
  const envWarnings: EnvSubstitutionWarning[] = [];
  const substituted = resolveConfigEnvVars(parsed, process.env, {
    onMissing: (w) => envWarnings.push(w),
  });

  const validated = OpenClaudeConfigSchema.parse(substituted);

  // Check enabled channels for unresolved env vars
  validateEnabledChannelEnvVars(validated, envWarnings);

  // Log warnings for disabled channels (non-fatal)
  for (const w of envWarnings) {
    console.error(`[config] Warning: env var ${w.varName} is not set (at ${w.configPath})`);
  }

  return validated;
}

function validateEnabledChannelEnvVars(
  config: OpenClaudeConfig,
  warnings: EnvSubstitutionWarning[],
): void {
  const enabledChannelPrefixes: string[] = [];

  if (config.channels.telegram?.enabled) {
    enabledChannelPrefixes.push("channels.telegram.");
  }
  if (config.channels.slack?.enabled) {
    enabledChannelPrefixes.push("channels.slack.");
  }

  for (const w of warnings) {
    const isEnabledChannel = enabledChannelPrefixes.some((prefix) =>
      w.configPath.startsWith(prefix),
    );
    if (isEnabledChannel) {
      throw new Error(
        `Channel config error: env var \${${w.varName}} is not set (at ${w.configPath}). ` +
        `Either set the env var or disable the channel.`,
      );
    }
  }
}
```

**Step 4: Update config-edge-cases.test.ts imports**

Replace `substituteEnvVars` / `substituteEnvVarsDeep` imports with `resolveConfigEnvVars` and update the tests to use the new API (pass env as second arg instead of modifying `process.env`).

**Step 5: Run all config tests**

Run: `pnpm test src/config/`
Expected: PASS

**Step 6: Commit**

```bash
git add src/config/loader.ts src/config/loader.test.ts src/config/config-edge-cases.test.ts
git commit -m "feat: lenient env var substitution for disabled channels

Disabled channels with missing env vars produce warnings instead of
crashing the gateway. Enabled channels with missing vars still error."
```

---

### Task 3: Create orphan reaper module

**Files:**
- Create: `src/engine/orphan-reaper.ts`
- Create: `src/engine/orphan-reaper.test.ts`

**Step 1: Write the failing tests**

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We test the pure parsing function directly and mock spawnSync for the rest
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
  parsePidsFromLsofOutput,
  findGatewayPidsOnPortSync,
  __testing,
} from "./orphan-reaper.js";

const mockSpawnSync = vi.mocked(spawnSync);

describe("parsePidsFromLsofOutput", () => {
  it("parses lsof -Fpc output and filters to openclaude processes", () => {
    const output = "p1234\ncnode\np5678\ncopenclaude\n";
    const pids = parsePidsFromLsofOutput(output);
    expect(pids).toEqual([5678]);
  });

  it("deduplicates PIDs from dual-stack listeners", () => {
    const output = "p1234\ncopenclaude\np1234\ncopenclaude\n";
    const pids = parsePidsFromLsofOutput(output);
    expect(pids).toEqual([1234]);
  });

  it("excludes current process PID", () => {
    const output = `p${process.pid}\ncopenclaude\n`;
    const pids = parsePidsFromLsofOutput(output);
    expect(pids).toEqual([]);
  });

  it("returns empty array for empty output", () => {
    expect(parsePidsFromLsofOutput("")).toEqual([]);
  });

  it("handles output with no openclaude processes", () => {
    const output = "p1234\ncnode\np5678\ncpython\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([]);
  });
});

describe("findGatewayPidsOnPortSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns PIDs from lsof output", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "p9999\ncopenclaude\n",
      stderr: "",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    const pids = findGatewayPidsOnPortSync(45557);
    expect(pids).toEqual([9999]);
  });

  it("returns empty array when lsof finds nothing (exit 1)", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
  });

  it("returns empty array on lsof error", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      pid: 0,
      output: [],
      signal: null,
    } as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
  });

  it("returns empty array on Windows", () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32" });
    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
    Object.defineProperty(process, "platform", { value: originalPlatform });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/engine/orphan-reaper.test.ts`
Expected: FAIL — module doesn't exist.

**Step 3: Write the implementation**

Create `src/engine/orphan-reaper.ts`, adapted from OpenClaw's `restart-stale-pids.ts`:

```typescript
/**
 * Orphan process reaper for OpenClaude gateway.
 * Adapted from OpenClaw's src/infra/restart-stale-pids.ts.
 *
 * Finds and kills stale gateway processes on the gateway port at startup,
 * then waits for the port to be released before proceeding.
 */
import { spawnSync } from "node:child_process";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;

let sleepSyncOverride: ((ms: number) => void) | null = null;
let dateNowOverride: (() => number) | null = null;

function getTimeMs(): number {
  return dateNowOverride ? dateNowOverride() : Date.now();
}

function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) return;
  if (sleepSyncOverride) {
    sleepSyncOverride(timeoutMs);
    return;
  }
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(lock, 0, 0, timeoutMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Best-effort fallback
    }
  }
}

/**
 * Parse openclaude gateway PIDs from lsof -Fpc stdout.
 * Pure function — no I/O. Excludes the current process.
 */
export function parsePidsFromLsofOutput(stdout: string): number[] {
  const pids: number[] = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaude")) {
        pids.push(currentPid);
      }
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }

  if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaude")) {
    pids.push(currentPid);
  }

  return [...new Set(pids)].filter((pid) => pid !== process.pid);
}

/**
 * Find PIDs of gateway processes listening on the given port.
 */
export function findGatewayPidsOnPortSync(
  port: number,
  spawnTimeoutMs = SPAWN_TIMEOUT_MS,
): number[] {
  if (process.platform === "win32") return [];

  const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: spawnTimeoutMs,
  });

  if (res.error) {
    console.error(`[orphan-reaper] lsof failed: ${(res.error as NodeJS.ErrnoException).code ?? res.error.message}`);
    return [];
  }
  if (res.status === 1) return [];
  if (res.status !== 0) {
    console.error(`[orphan-reaper] lsof exited with status ${res.status}`);
    return [];
  }

  return parsePidsFromLsofOutput(res.stdout);
}

type PollResult = { free: true } | { free: false } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  try {
    const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: POLL_SPAWN_TIMEOUT_MS,
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      const permanent = code === "ENOENT" || code === "EACCES" || code === "EPERM";
      return { free: null, permanent };
    }
    if (res.status === 1) {
      if (res.stdout) {
        const pids = parsePidsFromLsofOutput(res.stdout);
        return pids.length === 0 ? { free: true } : { free: false };
      }
      return { free: true };
    }
    if (res.status !== 0) return { free: null, permanent: false };
    const pids = parsePidsFromLsofOutput(res.stdout);
    return pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

function terminateStaleProcessesSync(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // ESRCH — already gone
    }
  }
  if (killed.length === 0) return killed;

  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return killed;
}

function waitForPortFreeSync(port: number): void {
  const deadline = getTimeMs() + PORT_FREE_TIMEOUT_MS;
  while (getTimeMs() < deadline) {
    const result = pollPortOnce(port);
    if (result.free === true) return;
    if (result.free === null && result.permanent) return;
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  console.error(`[orphan-reaper] port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}

/**
 * Kill stale gateway processes on the given port and wait for port release.
 * Call at gateway startup before binding the HTTP server.
 */
export function cleanStaleGatewayProcessesSync(port: number): number[] {
  try {
    const stalePids = findGatewayPidsOnPortSync(port);
    if (stalePids.length === 0) return [];

    console.error(
      `[orphan-reaper] killing ${stalePids.length} stale gateway process(es): ${stalePids.join(", ")}`,
    );
    const killed = terminateStaleProcessesSync(stalePids);
    waitForPortFreeSync(port);
    return killed;
  } catch {
    return [];
  }
}

export const __testing = {
  setSleepSyncOverride(fn: ((ms: number) => void) | null) {
    sleepSyncOverride = fn;
  },
  setDateNowOverride(fn: (() => number) | null) {
    dateNowOverride = fn;
  },
};
```

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/engine/orphan-reaper.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/engine/orphan-reaper.ts src/engine/orphan-reaper.test.ts
git commit -m "feat: add orphan process reaper adapted from OpenClaw

Uses lsof to find stale gateway processes on startup port.
SIGTERM -> 600ms -> SIGKILL -> poll for port release."
```

---

### Task 4: Wire orphan reaper into gateway lifecycle + add crash handlers

**Files:**
- Modify: `src/gateway/lifecycle.ts`
- Modify: `src/gateway/lifecycle.test.ts`

**Step 1: Write the failing tests**

Add to `src/gateway/lifecycle.test.ts`:

```typescript
// Add to mocks section:
const mockCleanStaleGatewayProcessesSync = vi.fn().mockReturnValue([]);
vi.mock("../engine/orphan-reaper.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) => mockCleanStaleGatewayProcessesSync(...args),
}));

// Add to describe("startGateway"):
it("calls orphan reaper on startup before binding port", async () => {
  mockLoadConfig.mockReturnValue(minimalConfig());
  const { startGateway } = await import("./lifecycle.js");
  await startGateway();

  expect(mockCleanStaleGatewayProcessesSync).toHaveBeenCalledWith(45557);
  // Reaper should be called before HTTP server starts
  expect(mockCleanStaleGatewayProcessesSync.mock.invocationCallOrder[0])
    .toBeLessThan(mockStartHttpServer.mock.invocationCallOrder[0]);
});
```

**Step 2: Run tests to verify they fail**

Run: `pnpm test src/gateway/lifecycle.test.ts`
Expected: FAIL — orphan reaper not imported or called.

**Step 3: Update lifecycle.ts**

Add import at top:

```typescript
import { cleanStaleGatewayProcessesSync } from "../engine/orphan-reaper.js";
import { killProcessGroup } from "../engine/spawn.js";
```

Add orphan reaping after config load, before HTTP server:

```typescript
// Inside startGateway(), after const gatewayPort:
// Reap stale gateway processes from previous crash
cleanStaleGatewayProcessesSync(gatewayPort);
```

Add crash handlers at the end of `startGateway()`, before the return:

```typescript
// Last-resort crash handlers
const onCrash = (err: unknown) => {
  console.error("[gateway] CRASH:", err instanceof Error ? err.message : String(err));
  // Best-effort: kill all known child processes
  for (const session of pool.listSessions()) {
    killProcessGroup(session.pid);
  }
  removePidFile();
  process.exit(1);
};
process.on("uncaughtException", onCrash);
process.on("unhandledRejection", onCrash);
```

Note: `removePidFile` is currently a module-level function so it's already accessible. Export `killProcessGroup` is already exported from `spawn.ts`.

**Step 4: Run tests to verify they pass**

Run: `pnpm test src/gateway/lifecycle.test.ts`
Expected: PASS

**Step 5: Run all tests**

Run: `pnpm test`
Expected: PASS

**Step 6: Commit**

```bash
git add src/gateway/lifecycle.ts src/gateway/lifecycle.test.ts
git commit -m "feat: wire orphan reaper + crash handlers into gateway lifecycle

Reaps stale processes on startup before binding port.
Adds uncaughtException/unhandledRejection handlers for best-effort cleanup."
```

---

### Task 5: Make drain() wait for process exit confirmation

**Files:**
- Modify: `src/engine/pool.ts`
- Modify: `src/engine/pool.test.ts`

**Step 1: Write the failing test**

Add to `src/engine/pool.test.ts`:

```typescript
it("drain() waits for killed processes to exit", async () => {
  const pool = createProcessPool(2);
  setupMockSpawn();

  pool.submit({ sessionId: "t1", prompt: "a" });
  pool.submit({ sessionId: "t2", prompt: "b" });

  // drain should resolve (it already does, but now it should also
  // attempt to confirm processes are dead)
  await pool.drain();

  expect(pool.stats().running).toBe(0);
  expect(pool.stats().queued).toBe(0);
});
```

**Step 2: Run test to verify baseline passes**

Run: `pnpm test src/engine/pool.test.ts`
Expected: PASS (this verifies the baseline before we change drain)

**Step 3: Update drain() in pool.ts**

Replace the `drain()` function:

```typescript
async function drain(): Promise<void> {
  draining = true;

  // Reject all queued tasks
  for (const queued of queue.splice(0)) {
    queued.reject(new Error("Pool draining"));
  }

  // Kill all running sessions and collect PIDs
  const pidsToWait: number[] = [];
  for (const [id, session] of running) {
    killProcessGroup(session.pid);
    if (session.pid !== undefined) {
      pidsToWait.push(session.pid);
    }
    session.status = "killed";
    session.completedAt = Date.now();
    running.delete(id);
  }

  // Wait for processes to actually exit (up to 2s)
  if (pidsToWait.length > 0) {
    await waitForProcessesExit(pidsToWait, 2000);
  }
}
```

Add helper function above `drain()`:

```typescript
function waitForProcessesExit(pids: number[], timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const check = () => {
      const alive = pids.filter((pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (alive.length === 0 || Date.now() >= deadline) {
        resolve();
        return;
      }
      setTimeout(check, 50);
    };
    check();
  });
}
```

**Step 4: Run all pool tests**

Run: `pnpm test src/engine/pool`
Expected: PASS

**Step 5: Commit**

```bash
git add src/engine/pool.ts src/engine/pool.test.ts
git commit -m "feat: drain() waits for child process exit confirmation

Polls kill(pid, 0) every 50ms up to 2s after SIGKILL to confirm
processes are actually dead before resolving."
```

---

### Task 6: Final integration test

**Step 1: Run full test suite**

Run: `pnpm test`
Expected: ALL PASS

**Step 2: Run lint**

Run: `pnpm lint`
Expected: PASS (or fix any lint issues)

**Step 3: Commit any fixes**

If lint or test fixes were needed, commit them.

**Step 4: Final commit with all changes**

If no further fixes needed, all work is already committed from previous tasks.
