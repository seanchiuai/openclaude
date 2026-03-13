/**
 * Claude Code CLI subprocess spawning.
 *
 * Spawns `claude -p` subprocesses with session isolation.
 * Writes prompts to files (never CLI args) for safety.
 * Uses --project for session isolation, --output-format json for structured output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config/paths.js";
import type { AgentTask, ClaudeResult, ClaudeSession } from "./types.js";

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export function spawnClaude(task: AgentTask): {
  session: ClaudeSession;
  promise: Promise<ClaudeResult>;
} {
  const projectPath = join(paths.sessions, task.sessionId);
  mkdirSync(projectPath, { recursive: true });

  // Write prompt to file — never pass user content as CLI args
  const promptFile = join(projectPath, "prompt.md");
  writeFileSync(promptFile, task.prompt, "utf-8");

  const timeout = task.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();

  const args = [
    "-p", // print mode (non-interactive)
    "--output-format",
    "json",
    "--input-file",
    promptFile,
    "--dangerously-skip-permissions",
  ];

  if (task.systemPrompt) {
    // --system-prompt takes a string literal, not a file path
    args.push("--system-prompt", task.systemPrompt);
  }

  if (task.mcpConfig && Object.keys(task.mcpConfig).length > 0) {
    const mcpConfigPath = join(projectPath, ".mcp.json");
    const mcpPayload = { mcpServers: task.mcpConfig };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpPayload), "utf-8");
    args.push("--mcp-config", mcpConfigPath);
  }

  // Build env: inherit process.env but unset CLAUDECODE to avoid nesting issues
  const env = { ...process.env };
  delete env.CLAUDECODE;

  const startedAt = Date.now();
  const proc = spawn("claude", args, {
    cwd: task.workingDirectory ?? projectPath,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
    detached: true, // Process group for clean kill
  });

  const session: ClaudeSession = {
    id: task.sessionId,
    projectPath,
    pid: proc.pid,
    status: "running",
    startedAt,
    timeout,
  };

  const promise = new Promise<ClaudeResult>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    proc.stderr?.on("data", (chunk: Buffer) => errChunks.push(chunk));

    // Wall-clock timeout with process group kill
    const timer = setTimeout(() => {
      session.status = "killed";
      session.completedAt = Date.now();
      session.error = `Timeout after ${timeout}ms`;
      killProcessGroup(proc.pid);
      controller.abort();
      reject(new Error(`Claude session ${task.sessionId} timed out after ${timeout}ms`));
    }, timeout);

    proc.on("close", (code, signal) => {
      clearTimeout(timer);
      const duration = Date.now() - startedAt;
      const stdout = Buffer.concat(chunks).toString("utf-8");
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        session.status = "killed";
        session.completedAt = Date.now();
        session.error = `Killed by signal ${signal}`;
        reject(new Error(`Claude session ${task.sessionId} killed by ${signal}`));
        return;
      }

      const exitCode = code ?? 1;
      const result = parseClaudeOutput(stdout, stderr, exitCode, duration);

      if (exitCode !== 0) {
        session.status = "failed";
        session.error = stderr || `Exit code ${exitCode}`;
      } else {
        session.status = "completed";
      }

      session.completedAt = Date.now();
      session.result = result;
      resolve(result);
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      session.status = "failed";
      session.completedAt = Date.now();
      session.error = err.message;
      reject(err);
    });
  });

  return { session, promise };
}

function parseClaudeOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  duration: number,
): ClaudeResult {
  // Claude --output-format json wraps output in a JSON object
  let text = stdout;
  let raw: unknown = undefined;

  try {
    const parsed = JSON.parse(stdout);
    raw = parsed;
    // Claude JSON output has a "result" field with the text
    if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      text = String(parsed.result);
    }
  } catch {
    // Not JSON, use raw stdout
  }

  return { text: text.trim(), raw, exitCode, duration };
}

function killProcessGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    // Kill the entire process group (negative pid)
    process.kill(-pid, "SIGKILL");
  } catch {
    // Process may already be dead
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore
    }
  }
}

export { killProcessGroup };
