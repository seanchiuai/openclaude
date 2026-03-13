/**
 * Contract: Claude Code CLI Subprocess Spawning
 *
 * spawnClaude(task) spawns a `claude -p` subprocess with session isolation.
 * - Writes prompt to a file, never passes it as CLI args
 * - Passes --input-file, --output-format json, --dangerously-skip-permissions
 * - Unsets CLAUDECODE env var to avoid nesting
 * - Spawns with detached:true for process group kill
 * - Parses JSON stdout → ClaudeResult with text, raw, exitCode, duration
 * - Handles non-JSON stdout gracefully (uses raw text)
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
} {
  const proc = new EventEmitter() as ChildProcess & {
    _stdout: EventEmitter;
    _stderr: EventEmitter;
  };
  proc._stdout = new EventEmitter();
  proc._stderr = new EventEmitter();
  proc.stdout = proc._stdout as unknown as Readable;
  proc.stderr = proc._stderr as unknown as Readable;
  proc.pid = 12345;
  proc.stdin = null;
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

  it("passes --input-file, --output-format json, --dangerously-skip-permissions", () => {
    spawnClaude({ sessionId: "s1", prompt: "test" });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args).toContain("-p");
    expect(args).toContain("--output-format");
    expect(args).toContain("json");
    expect(args).toContain("--input-file");
    expect(args).toContain("--dangerously-skip-permissions");
    // --input-file should be followed by the prompt file path
    const inputFileIdx = args.indexOf("--input-file");
    expect(args[inputFileIdx + 1]).toContain("prompt.md");
  });

  it("unsets CLAUDECODE env var", () => {
    process.env.CLAUDECODE = "should-be-removed";
    spawnClaude({ sessionId: "s1", prompt: "test" });

    const spawnOpts = mockSpawn.mock.calls[0][2] as { env: Record<string, string | undefined> };
    expect(spawnOpts.env.CLAUDECODE).toBeUndefined();
    delete process.env.CLAUDECODE;
  });

  it("spawns with detached:true for process group", () => {
    spawnClaude({ sessionId: "s1", prompt: "test" });

    const spawnOpts = mockSpawn.mock.calls[0][2] as { detached: boolean };
    expect(spawnOpts.detached).toBe(true);
  });

  it("creates project directory for session isolation", () => {
    spawnClaude({ sessionId: "my-session", prompt: "test" });

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("my-session"),
      { recursive: true },
    );
  });

  it("parses JSON output → ClaudeResult", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    const jsonOutput = JSON.stringify({ result: "Hello from Claude" });
    mockProc._stdout.emit("data", Buffer.from(jsonOutput));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.text).toBe("Hello from Claude");
    expect(result.raw).toEqual({ result: "Hello from Claude" });
    expect(result.exitCode).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
  });

  it("handles non-JSON stdout gracefully", async () => {
    const { promise } = spawnClaude({ sessionId: "s1", prompt: "test" });

    mockProc._stdout.emit("data", Buffer.from("Plain text output"));
    mockProc.emit("close", 0, null);

    const result = await promise;
    expect(result.text).toBe("Plain text output");
    expect(result.raw).toBeUndefined();
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
