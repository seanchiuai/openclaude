/**
 * Contract: Claude Code CLI Subprocess Spawning
 *
 * spawnClaude(task) spawns a `claude -p` subprocess with session isolation.
 * - Writes prompt to a file for record-keeping, and pipes it via stdin
 * - Passes -p, --output-format stream-json (no --input-file, no --dangerously-skip-permissions)
 * - Unsets CLAUDECODE env var to avoid nesting
 * - Spawns with detached:true for process group kill
 * - Parses NDJSON stream output → finds last "result" event → ClaudeResult
 * - Handles non-JSON stdout gracefully (skips non-JSON lines)
 * - Non-zero exit code → result.exitCode reflects it
 * - Timeout → SIGKILL to process group (negative pid)
 * - AbortController used for timeout cancellation
 * - Process 'error' event → promise rejects with error message
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Readable } from "node:stream";

// Mock child_process.spawn
vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

// Mock fs operations
vi.mock("node:fs", () => ({
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnClaude, killProcessGroup } from "./spawn.js";

const mockSpawn = vi.mocked(spawn);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockMkdirSync = vi.mocked(mkdirSync);

function createMockProcess(): ChildProcess & {
  _stdout: EventEmitter;
  _stderr: EventEmitter;
  _stdinData: string[];
} {
  const proc = new EventEmitter() as ChildProcess & {
    _stdout: EventEmitter;
    _stderr: EventEmitter;
    _stdinData: string[];
  };
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  proc._stdinData = [];
  proc.stdout = proc._stdout as unknown as Readable;
  proc.stderr = proc._stderr as unknown as Readable;
  proc.pid = 12345;
  // Mock writable stdin
  proc.stdin = {
    write: (data: string) => { proc._stdinData.push(data); return true; },
    end: () => {},
  } as unknown as ChildProcess["stdin"];
  return proc;
}

describe("spawnClaude", () => {
  let mockProc: ReturnType<typeof createMockProcess>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockProc = createMockProcess();
    mockSpawn.mockReturnValue(mockProc);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("writes prompt to file, never CLI args", () => {
    spawnClaude({ sessionId: "s1", prompt: "Hello world" });

    // Verify writeFileSync was called with the prompt
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      expect.stringContaining("prompt.md"),
      "Hello world",
      "utf-8",
    );

    // Verify spawn args do NOT contain the prompt text
    const spawnArgs = mockSpawn.mock.calls[0][1] as string[];
    expect(spawnArgs).not.toContain("Hello world");
  });

  it("passes -p and --output-format stream-json, pipes prompt via stdin", () => {
    spawnClaude({ sessionId: "s1", prompt: "test prompt" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("stream-json");
    // No --input-file (doesn't exist) or --dangerously-skip-permissions (forces API auth)
    expect(args).not.toContain("--input-file");
    expect(args).not.toContain("--dangerously-skip-permissions");
    // Prompt piped via stdin
    expect(mockProc._stdinData).toContain("test prompt");
  });

  it("unsets CLAUDECODE env var", () => {
    process.env.CLAUDECODE = "should-be-removed";
    spawnClaude({ sessionId: "s1", prompt: "test" });

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOpts.env.CLAUDECODE).toBeUndefined();
    delete process.env.CLAUDECODE;
  });

  it("spawns with detached:true and pipe stdio", () => {
    spawnClaude({ sessionId: "s1", prompt: "test" });

    const spawnOpts = mockSpawn.mock.calls[0][2] as { detached: boolean; stdio: string[] };
    expect(spawnOpts.detached).toBe(true);
    expect(spawnOpts.stdio).toEqual(["pipe", "pipe", "pipe"]);
  });

  it("creates project directory for session isolation", () => {
    spawnClaude({ sessionId: "my-session", prompt: "test" });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("my-session"),
      { recursive: true },
    );
  });

  it("parses NDJSON stream output → extracts result event", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    // NDJSON: one JSON object per line
    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Hello" }] } }),
      JSON.stringify({ type: "result", subtype: "success", result: "Hello from Claude", is_error: false }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.text).toBe("Hello from Claude");
    expect(result.raw).toBeInstanceOf(Array);
    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("handles non-JSON stdout gracefully (returns empty text)", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    // Non-JSON lines are skipped by the NDJSON parser
    mockProc._stdout.emit("data", Buffer.from("Plain text output\n"));
    mockProc.emit("close", 0, null);

    const result = await promise;
    // With NDJSON parsing, non-JSON lines are skipped — no result event means empty text
    expect(result.text).toBe("");
    expect(result.raw).toBeInstanceOf(Array);
    expect(result.exitCode).toBe(0);
  });

  it("non-zero exit code → result.exitCode reflects it", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    mockProc._stdout.emit("data", Buffer.from("error output"));
    mockProc._stderr.emit("data", Buffer.from("something failed"));
    mockProc.emit("close", 1, null);

    const result = await promise;
    expect(result.exitCode).toBe(1);
  });

  it("timeout triggers SIGKILL to process group (negative pid)", async () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const { promise } = spawnClaude({
      sessionId: "s1",
      prompt: "test",
      timeout: 1000,
    });

    // Advance time past the timeout
    vi.advanceTimersByTime(1001);

    await expect(promise).rejects.toThrow("timed out");

    // Should have called process.kill with negative pid (process group)
    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");

    killSpy.mockRestore();
  });

  it("process error event → rejection with error message", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    mockProc.emit("error", new Error("spawn ENOENT"));

    await expect(promise).rejects.toThrow("spawn ENOENT");
  });

  it("session status tracks lifecycle", () => {
    const { session } = spawnClaude({ sessionId: "s1", prompt: "test" });

    expect(session.id).toBe("s1");
    expect(session.status).toBe("running");
    expect(session.pid).toBe(12345);
    expect(session.startedAt).toBeGreaterThan(0);
  });

  it("killed by signal → session marked as killed", async () => {
    const { session, promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    mockProc.emit("close", null, "SIGKILL");

    await expect(promise).rejects.toThrow("killed");
    expect(session.status).toBe("killed");
  });

  it("passes --system-prompt when provided", () => {
    spawnClaude({
      sessionId: "s1",
      prompt: "test",
      systemPrompt: "You are a helpful assistant",
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--system-prompt");
    expect(args).toContain("You are a helpful assistant");
  });

  it("passes --session-id when claudeSessionId is set (first message)", () => {
    spawnClaude({
      sessionId: "s1",
      prompt: "test",
      claudeSessionId: "uuid-abc-123",
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--session-id");
    expect(args).toContain("uuid-abc-123");
    expect(args).not.toContain("--resume");
  });

  it("passes --resume when resumeSession is true", () => {
    spawnClaude({
      sessionId: "s1",
      prompt: "test",
      claudeSessionId: "uuid-abc-123",
      resumeSession: true,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("--resume");
    expect(args).toContain("uuid-abc-123");
    expect(args).not.toContain("--session-id");
  });

  it("skips --system-prompt when resumeSession is true", () => {
    spawnClaude({
      sessionId: "s1",
      prompt: "test",
      systemPrompt: "You are helpful.",
      claudeSessionId: "uuid-abc-123",
      resumeSession: true,
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--system-prompt");
  });

  it("does not pass session flags when claudeSessionId is undefined", () => {
    spawnClaude({
      sessionId: "s1",
      prompt: "test",
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).not.toContain("--session-id");
    expect(args).not.toContain("--resume");
  });

  it("extracts token usage from result event", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        result: "Done!",
        num_turns: 3,
        total_cost_usd: 0.05,
        usage: {
          input_tokens: 1500,
          output_tokens: 500,
          cache_read_input_tokens: 200,
          cache_creation_input_tokens: 100,
        },
      }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.usage).toEqual({
      inputTokens: 1500,
      outputTokens: 500,
      cacheReadTokens: 200,
      cacheCreationTokens: 100,
      totalCostUsd: 0.05,
    });
    expect(result.numTurns).toBe(3);
  });

  it("detects compact_boundary event", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 180000 },
      }),
      JSON.stringify({ type: "result", result: "Done!" }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.compacted).toBe(true);
    expect(result.preCompactTokens).toBe(180000);
  });

  it("emits usage and compaction stream events via onEvent", async () => {
    const events: unknown[] = [];
    const onEvent = (e: unknown) => events.push(e);
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" }, onEvent);

    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "abc" }),
      JSON.stringify({
        type: "system",
        subtype: "compact_boundary",
        compact_metadata: { trigger: "auto", pre_tokens: 150000 },
      }),
      JSON.stringify({
        type: "result",
        result: "Done!",
        total_cost_usd: 0.03,
        usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    await promise;
    expect(events).toContainEqual({ type: "compaction", preTokens: 150000 });
    expect(events).toContainEqual({ type: "usage", inputTokens: 1000, outputTokens: 200, costUsd: 0.03 });
  });

  it("result without usage field leaves usage undefined", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    const ndjson = [
      JSON.stringify({ type: "result", result: "Done!" }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.usage).toBeUndefined();
    expect(result.compacted).toBeUndefined();
  });

  it("extracts claudeSessionId from init event in NDJSON output", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    const ndjson = [
      JSON.stringify({ type: "system", subtype: "init", session_id: "extracted-uuid-456" }),
      JSON.stringify({ type: "result", result: "Done!" }),
    ].join("\n") + "\n";
    mockProc._stdout.emit("data", Buffer.from(ndjson));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.claudeSessionId).toBe("extracted-uuid-456");
    expect(result.text).toBe("Done!");
  });
});

describe("killProcessGroup", () => {
  it("kills process group with negative pid", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    killProcessGroup(12345);

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    killSpy.mockRestore();
  });

  it("falls back to killing just the pid if group kill fails", () => {
    const killSpy = vi.spyOn(process, "kill").mockImplementation((pid) => {
      if (typeof pid === "number" && pid < 0) throw new Error("no such group");
      return true;
    });

    killProcessGroup(12345);

    expect(killSpy).toHaveBeenCalledWith(-12345, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(12345, "SIGKILL");
    killSpy.mockRestore();
  });

  it("handles undefined pid gracefully", () => {
    // Should not throw
    killProcessGroup(undefined);
  });
});
