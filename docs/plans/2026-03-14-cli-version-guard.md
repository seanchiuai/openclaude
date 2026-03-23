# CLI Version Guard Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a startup check that logs the Claude Code CLI version and fails fast if the binary is missing or incompatible.

**Architecture:** A single `checkClaudeCliVersion()` function in `src/engine/cli-version.ts` that runs `claude --version`, parses the output, logs it, and throws if the binary is absent. Called once at gateway startup before the first channel starts. No abstraction layer — just a guard.

**Tech Stack:** Node.js `child_process.execFileSync`, vitest

---

### Task 1: Add `cli-version.ts` with version check function

**Files:**
- Create: `src/engine/cli-version.ts`
- Test: `src/engine/cli-version.test.ts`

**Step 1: Write the failing test**

```typescript
// src/engine/cli-version.test.ts
import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from "node:child_process";
import { checkClaudeCliVersion } from "./cli-version.js";

const mockExecFileSync = vi.mocked(execFileSync);

describe("checkClaudeCliVersion", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns parsed version when claude --version succeeds", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("1.0.20 (Claude Code)\n"));

    const result = checkClaudeCliVersion();

    expect(result).toEqual({ raw: "1.0.20 (Claude Code)", version: "1.0.20" });
    expect(mockExecFileSync).toHaveBeenCalledWith("claude", ["--version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("returns raw string when version format is unexpected", () => {
    mockExecFileSync.mockReturnValue(Buffer.from("some-future-format v2\n"));

    const result = checkClaudeCliVersion();

    expect(result).toEqual({ raw: "some-future-format v2", version: undefined });
  });

  it("throws when claude binary is not found", () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(() => checkClaudeCliVersion()).toThrow(
      /Claude Code CLI not found/,
    );
  });

  it("throws with stderr content on non-zero exit", () => {
    const err = new Error("Command failed") as Error & { stderr: Buffer };
    err.stderr = Buffer.from("permission denied\n");
    mockExecFileSync.mockImplementation(() => { throw err; });

    expect(() => checkClaudeCliVersion()).toThrow(/permission denied/);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/cli-version.test.ts`
Expected: FAIL — module `./cli-version.js` not found

**Step 3: Write minimal implementation**

```typescript
// src/engine/cli-version.ts
/**
 * Claude Code CLI version check.
 *
 * Runs `claude --version` and returns the parsed version string.
 * Throws if the binary is missing or the command fails.
 */
import { execFileSync } from "node:child_process";

export interface CliVersionResult {
  /** Full output of `claude --version` */
  raw: string;
  /** Parsed semver-ish version (e.g. "1.0.20"), undefined if unparseable */
  version: string | undefined;
}

export function checkClaudeCliVersion(): CliVersionResult {
  let stdout: string;
  try {
    const buf = execFileSync("claude", ["--version"], {
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    stdout = (typeof buf === "string" ? buf : buf.toString("utf-8")).trim();
  } catch (err: unknown) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code",
      );
    }
    const stderr = err instanceof Error && "stderr" in err
      ? Buffer.isBuffer((err as { stderr: unknown }).stderr)
        ? ((err as { stderr: Buffer }).stderr).toString("utf-8").trim()
        : String((err as { stderr: unknown }).stderr).trim()
      : "";
    throw new Error(
      `Claude Code CLI check failed: ${stderr || (err instanceof Error ? err.message : String(err))}`,
    );
  }

  // Parse version: "1.0.20 (Claude Code)" → "1.0.20"
  const match = stdout.match(/^(\d+\.\d+\.\d+)/);
  return {
    raw: stdout,
    version: match?.[1],
  };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/cli-version.test.ts`
Expected: PASS (4 tests)

**Step 5: Commit**

```bash
git add src/engine/cli-version.ts src/engine/cli-version.test.ts
git commit -m "feat(engine): add Claude Code CLI version check"
```

---

### Task 2: Call version check at gateway startup

**Files:**
- Modify: `src/gateway/lifecycle.ts` (add import + call after `ensureDirectories()`)
- Modify: `src/gateway/lifecycle.test.ts` (add test for startup version logging)

**Step 1: Write the failing test**

Add to `src/gateway/lifecycle.test.ts`:

```typescript
it("logs Claude CLI version at startup", async () => {
  // checkClaudeCliVersion is called during startGateway
  // Verify it was imported and called
  const { checkClaudeCliVersion } = await import("../engine/cli-version.js");
  expect(vi.mocked(checkClaudeCliVersion)).toHaveBeenCalled();
});
```

Note: The existing lifecycle test file already mocks most dependencies. Add `cli-version.js` to the mock list:

```typescript
vi.mock("../engine/cli-version.js", () => ({
  checkClaudeCliVersion: vi.fn(() => ({ raw: "1.0.20 (Claude Code)", version: "1.0.20" })),
}));
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/gateway/lifecycle.test.ts`
Expected: FAIL — `checkClaudeCliVersion` never called

**Step 3: Add version check to lifecycle.ts**

Add import at top of `src/gateway/lifecycle.ts`:
```typescript
import { checkClaudeCliVersion } from "../engine/cli-version.js";
```

Add call after `ensureDirectories()` (line 47), before pool creation:
```typescript
  ensureDirectories();

  // Verify Claude Code CLI is available before starting anything
  const cliVersion = checkClaudeCliVersion();
  log.info(`Claude Code CLI: ${cliVersion.raw}`);

  const config = loadConfig(configPath);
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/gateway/lifecycle.test.ts`
Expected: PASS

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/gateway/lifecycle.ts src/gateway/lifecycle.test.ts
git commit -m "feat(gateway): check Claude CLI version at startup"
```

---

### Task 3: Add NDJSON event schema validation (defensive, non-blocking)

**Files:**
- Create: `src/engine/event-schema.ts`
- Test: `src/engine/event-schema.test.ts`

**Step 1: Write the failing test**

```typescript
// src/engine/event-schema.test.ts
import { describe, it, expect } from "vitest";
import { classifyEvent, type ClassifiedEvent } from "./event-schema.js";

describe("classifyEvent", () => {
  it("classifies init event and extracts session_id", () => {
    const event = { type: "system", subtype: "init", session_id: "abc-123" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "init", sessionId: "abc-123" });
  });

  it("classifies result event and extracts fields", () => {
    const event = {
      type: "result",
      result: "Hello!",
      num_turns: 2,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "result",
      text: "Hello!",
      numTurns: 2,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.01,
      },
    });
  });

  it("classifies result event with missing usage gracefully", () => {
    const event = { type: "result", result: "Done" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "result", text: "Done", numTurns: undefined, usage: undefined });
  });

  it("classifies compact_boundary event", () => {
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 180000 },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "compaction", preTokens: 180000 });
  });

  it("classifies assistant text content", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "assistant",
      textBlocks: ["Hi"],
      toolUseNames: [],
    });
  });

  it("classifies assistant tool_use content", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "assistant",
      textBlocks: [],
      toolUseNames: ["Read"],
    });
  });

  it("returns unknown for unrecognized event types", () => {
    const event = { type: "something_new", data: "future" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "unknown" });
  });

  it("returns unknown for events missing type field", () => {
    const result = classifyEvent({ data: "no type" });
    expect(result).toEqual({ kind: "unknown" });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/engine/event-schema.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/engine/event-schema.ts
/**
 * Claude Code CLI NDJSON event classification.
 *
 * Extracts structured data from raw CLI events with graceful handling
 * of missing or renamed fields. Centralizes the event schema contract
 * so spawn.ts doesn't do ad-hoc field access.
 */
import type { TokenUsage } from "./types.js";

export type ClassifiedEvent =
  | { kind: "init"; sessionId: string }
  | { kind: "result"; text: string; numTurns: number | undefined; usage: TokenUsage | undefined }
  | { kind: "compaction"; preTokens: number | undefined }
  | { kind: "assistant"; textBlocks: string[]; toolUseNames: string[] }
  | { kind: "unknown" };

export function classifyEvent(event: Record<string, unknown>): ClassifiedEvent {
  if (typeof event.type !== "string") return { kind: "unknown" };

  // Init event: { type: "system", subtype: "init", session_id: "..." }
  if (event.type === "system" && event.subtype === "init" && typeof event.session_id === "string") {
    return { kind: "init", sessionId: event.session_id };
  }

  // Compaction: { type: "system", subtype: "compact_boundary", compact_metadata: { pre_tokens: N } }
  if (event.type === "system" && event.subtype === "compact_boundary") {
    const metadata = event.compact_metadata as Record<string, unknown> | undefined;
    return { kind: "compaction", preTokens: (metadata?.pre_tokens as number) ?? undefined };
  }

  // Result: { type: "result", result: "...", usage: {...}, num_turns: N, total_cost_usd: N }
  if (event.type === "result") {
    const text = typeof event.result === "string" ? event.result : "";
    const numTurns = (event.num_turns as number) ?? undefined;
    const u = event.usage as Record<string, unknown> | undefined;
    const usage = u
      ? {
          inputTokens: (u.input_tokens as number) ?? 0,
          outputTokens: (u.output_tokens as number) ?? 0,
          cacheReadTokens: (u.cache_read_input_tokens as number) ?? 0,
          cacheCreationTokens: (u.cache_creation_input_tokens as number) ?? 0,
          totalCostUsd: (event.total_cost_usd as number) ?? 0,
        }
      : undefined;
    return { kind: "result", text, numTurns, usage };
  }

  // Assistant: { type: "assistant", message: { content: [...] } } or { type: "assistant", content: [...] }
  if (event.type === "assistant") {
    const content =
      (event.content as Array<Record<string, unknown>> | undefined) ??
      ((event.message as Record<string, unknown> | undefined)?.content as Array<Record<string, unknown>> | undefined);
    const textBlocks: string[] = [];
    const toolUseNames: string[] = [];
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "text" && typeof block.text === "string") textBlocks.push(block.text);
        if (block.type === "tool_use" && typeof block.name === "string") toolUseNames.push(block.name);
      }
    }
    return { kind: "assistant", textBlocks, toolUseNames };
  }

  return { kind: "unknown" };
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/engine/event-schema.test.ts`
Expected: PASS (8 tests)

**Step 5: Commit**

```bash
git add src/engine/event-schema.ts src/engine/event-schema.test.ts
git commit -m "feat(engine): add NDJSON event classification with schema contract"
```

---

### Task 4: Refactor spawn.ts to use classifyEvent

**Files:**
- Modify: `src/engine/spawn.ts` (replace inline field access with classifyEvent calls)

**Step 1: Run existing tests to establish baseline**

Run: `pnpm vitest run src/engine/spawn.test.ts`
Expected: PASS (all existing tests)

**Step 2: Refactor spawn.ts event processing**

In `src/engine/spawn.ts`, add import:
```typescript
import { classifyEvent } from "./event-schema.js";
```

Replace the inline event processing block (lines 141-187) with:

```typescript
          const classified = classifyEvent(event);

          if (classified.kind === "init") {
            streamSessionId = classified.sessionId;
          }

          if (classified.kind === "result") {
            if (classified.usage) {
              usage = classified.usage;
              if (onEvent) {
                onEvent({ type: "usage", inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, costUsd: usage.totalCostUsd });
              }
            }
            numTurns = classified.numTurns;
          }

          if (classified.kind === "compaction") {
            compacted = true;
            preCompactTokens = classified.preTokens;
            if (onEvent && typeof preCompactTokens === "number") {
              onEvent({ type: "compaction", preTokens: preCompactTokens });
            }
          }

          if (classified.kind === "assistant" && onEvent) {
            for (const text of classified.textBlocks) {
              onEvent({ type: "text", text });
            }
            for (const name of classified.toolUseNames) {
              onEvent({ type: "status", message: `[Using tool: ${name}]` });
            }
          }
```

Also update the close handler's init fallback (lines 215-217):
```typescript
          const classified = classifyEvent(event);
          if (classified.kind === "init") {
            streamSessionId = classified.sessionId;
          }
```

**Step 3: Run existing tests to verify no regressions**

Run: `pnpm vitest run src/engine/spawn.test.ts`
Expected: PASS (all existing tests still pass — behavior is identical)

**Step 4: Run full test suite**

Run: `pnpm test`
Expected: All tests pass

**Step 5: Commit**

```bash
git add src/engine/spawn.ts
git commit -m "refactor(engine): use classifyEvent for NDJSON event processing"
```

---

## Summary

| Task | What | Files | Effort |
|------|------|-------|--------|
| 1 | CLI version check function | cli-version.ts + test | ~10 min |
| 2 | Call at gateway startup | lifecycle.ts + test | ~5 min |
| 3 | Event classification module | event-schema.ts + test | ~10 min |
| 4 | Refactor spawn.ts to use it | spawn.ts | ~10 min |

**Total: ~35 minutes**

After this, the CLI event schema is documented in one place (`event-schema.ts`), the version is logged at startup, and `spawn.ts` no longer does ad-hoc field access. If Claude Code changes their event format, you update `classifyEvent()` and all consumers follow.
