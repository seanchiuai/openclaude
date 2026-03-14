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
