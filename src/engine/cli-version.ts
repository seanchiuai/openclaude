/**
 * Claude Code CLI version check.
 *
 * Runs `claude --version` and returns the parsed version string.
 * Throws if the binary is missing or the command fails.
 */
import { execFileSync } from "node:child_process";

export interface CliVersionResult {
  raw: string;
  version: string | undefined;
}

export function checkClaudeCliVersion(): CliVersionResult {
  let stdout: string;
  try {
    stdout = execFileSync("claude", ["--version"], {
      timeout: 5000,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (err: unknown) {
    const e = err as Record<string, unknown>;
    if (e.code === "ENOENT") {
      throw new Error(
        "Claude Code CLI not found. Install it: https://docs.anthropic.com/en/docs/claude-code",
      );
    }
    const stderr = e.stderr ? String(e.stderr).trim() : "";
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Claude Code CLI check failed: ${stderr || message}`);
  }

  const match = stdout.match(/^(\d+\.\d+\.\d+)/);
  return { raw: stdout, version: match?.[1] };
}
