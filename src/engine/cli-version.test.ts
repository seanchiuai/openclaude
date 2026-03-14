import { describe, it, expect, vi, afterEach } from "vitest";

const mockExecFileSync = vi.fn();
vi.mock("node:child_process", () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

import { checkClaudeCliVersion } from "./cli-version.js";

describe("checkClaudeCliVersion", () => {
  afterEach(() => vi.clearAllMocks());

  it("returns parsed version when claude --version succeeds", () => {
    mockExecFileSync.mockReturnValue("1.0.20 (Claude Code)\n");

    const result = checkClaudeCliVersion();

    expect(result).toEqual({ raw: "1.0.20 (Claude Code)", version: "1.0.20" });
    expect(mockExecFileSync).toHaveBeenCalledWith("claude", ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  });

  it("returns raw string when version format is unexpected", () => {
    mockExecFileSync.mockReturnValue("some-future-format v2\n");

    const result = checkClaudeCliVersion();

    expect(result).toEqual({ raw: "some-future-format v2", version: undefined });
  });

  it("throws when claude binary is not found", () => {
    mockExecFileSync.mockImplementation(() => {
      const err = new Error("spawn claude ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(() => checkClaudeCliVersion()).toThrow(/Claude Code CLI not found/);
  });

  it("throws with stderr content on non-zero exit", () => {
    mockExecFileSync.mockImplementation(() => {
      const err = Object.assign(new Error("Command failed"), { stderr: "permission denied\n" });
      throw err;
    });

    expect(() => checkClaudeCliVersion()).toThrow(/permission denied/);
  });
});
