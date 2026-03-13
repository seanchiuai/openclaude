/**
 * Claude Code CLI subprocess spawning.
 *
 * Spawns `claude -p` subprocesses with session isolation.
 * Writes prompts to files (never CLI args) for safety.
 * Uses --project for session isolation, --output-format json for structured output.
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { paths } from "../config/paths.js";
import type { AgentTask, ClaudeResult, ClaudeSession } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export function spawnClaude(task: AgentTask): {
  session: ClaudeSession;
  promise: Promise<ClaudeResult>;
} {
  const projectPath = join(paths.sessions, task.sessionId);
  mkdirSync(projectPath, { recursive: true });

  // Write prompt to file for record-keeping
  const promptFile = join(projectPath, "prompt.md");
  writeFileSync(promptFile, task.prompt, "utf-8");

  const timeout = task.timeout ?? DEFAULT_TIMEOUT;
  const controller = new AbortController();

  const args = [
    "-p", // print mode (non-interactive)
    "--output-format",
    "json",
  ];

  if (task.systemPrompt) {
    // --system-prompt takes a string literal, not a file path
    args.push("--system-prompt", task.systemPrompt);
  }

  // Build MCP config: merge user-configured servers with auto-injected gateway server.
  // The gateway server takes precedence on name collision.
  const gatewayMcp = task.gatewayUrl
    ? {
        "openclaude-gateway": {
          command: "node",
          args: [join(__dirname, "mcp/gateway-tools-server.js")],
          env: { GATEWAY_URL: task.gatewayUrl },
        },
      }
    : {};
  const mergedMcp = { ...(task.mcpConfig ?? {}), ...gatewayMcp };

  if (Object.keys(mergedMcp).length > 0) {
    const mcpConfigPath = join(projectPath, ".mcp.json");
    const mcpPayload = { mcpServers: mergedMcp };
    writeFileSync(mcpConfigPath, JSON.stringify(mcpPayload), "utf-8");
    args.push("--mcp-config", mcpConfigPath);
  }

  // Build env: inherit process.env but clean up problematic vars
  const env = { ...process.env };
  delete env.CLAUDECODE; // Avoid "nested session" error
  delete env.ANTHROPIC_API_KEY; // Force OAuth/subscription, never API key auth
  delete env.CLAUDE_API_KEY; // Same
  delete env.CLAUDE_CODE_ENTRYPOINT; // Don't inherit parent entrypoint

  const startedAt = Date.now();
  const proc = spawn("claude", args, {
    cwd: task.workingDirectory ?? projectPath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
    detached: true, // Process group for clean kill
  });

  // Write prompt via stdin (claude -p reads from stdin)
  proc.stdin?.write(task.prompt);
  proc.stdin?.end();

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
    // Claude --output-format json returns an array of events.
    // Find the last "result" event and extract the result text.
    if (Array.isArray(parsed)) {
      const resultEvent = parsed.findLast(
        (e: Record<string, unknown>) => e.type === "result",
      );
      if (resultEvent && typeof resultEvent.result === "string") {
        text = resultEvent.result;
      }
    } else if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
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
