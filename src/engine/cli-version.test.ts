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
