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
import { classifyEvent } from "./event-schema.js";
import type { AgentTask, ClaudeResult, ClaudeSession, OnStreamEvent, SpawnOptions, TokenUsage } from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const DEFAULT_TIMEOUT = 300_000; // 5 minutes

export function spawnClaude(task: AgentTask, onEvent?: OnStreamEvent, options?: SpawnOptions): {
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
    "stream-json",
  ];

  // Add session flags: --resume for continuing, --session-id for new named sessions
  if (task.resumeSession && task.claudeSessionId) {
    args.push("--resume", task.claudeSessionId);
  } else if (task.claudeSessionId) {
    args.push("--session-id", task.claudeSessionId);
  }

  // Only pass --system-prompt on first message (not on resume — context is already in session)
  if (task.systemPrompt && !task.resumeSession) {
    args.push("--system-prompt", task.systemPrompt);
  }

  // Model override (e.g. for subagents using a cheaper model)
  if (task.model) {
    args.push("--model", task.model);
  }

  // Build MCP config: merge user-configured servers with auto-injected gateway server.
  // The gateway server takes precedence on name collision.
  const gatewayMcpEnv: Record<string, string> = {};
  if (task.gatewayUrl) gatewayMcpEnv.GATEWAY_URL = task.gatewayUrl;
  if (task.gatewayToken) gatewayMcpEnv.GATEWAY_TOKEN = task.gatewayToken;
  gatewayMcpEnv.OPENCLAUDE_SESSION_ID = task.sessionId;
  if (task.sessionId.startsWith("sub-")) gatewayMcpEnv.CHILD_MODE = "true";

  const gatewayMcp = task.gatewayUrl
    ? {
        "openclaude-gateway": {
          command: "node",
          args: [join(__dirname, "../mcp/gateway-tools-server.js")],
          env: gatewayMcpEnv,
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

  if (options?.env) Object.assign(env, options.env);

  const startedAt = Date.now();
  const binary = options?.claudeBinary ?? "claude";
  const useShell = binary.includes(" ");
  const spawnCmd = useShell ? `${binary} ${args.join(" ")}` : binary;
  const spawnArgs = useShell ? [] : args;
  const proc = spawn(spawnCmd, spawnArgs, {
    cwd: task.workingDirectory ?? projectPath,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: controller.signal,
    detached: !useShell, // Don't detach when using shell (process group semantics differ)
    shell: useShell,
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
    const rawEvents: Record<string, unknown>[] = [];
    const errChunks: Buffer[] = [];
    let lineBuf = "";
    let streamSessionId: string | undefined;
    let usage: TokenUsage | undefined;
    let numTurns: number | undefined;
    let compacted = false;
    let preCompactTokens: number | undefined;

    proc.stdout?.on("data", (chunk: Buffer) => {
      lineBuf += chunk.toString("utf-8");
      const lines = lineBuf.split("\n");
      // Keep the last (possibly incomplete) line in the buffer
      lineBuf = lines.pop()!;

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          rawEvents.push(event);

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
            try {
              for (const text of classified.textBlocks) {
                onEvent({ type: "text", text });
              }
              for (const name of classified.toolUseNames) {
                onEvent({ type: "status", message: `[Using tool: ${name}]` });
              }
            } catch {
              // Don't let streaming callback errors crash the spawn promise
            }
          }
        } catch {
          // Skip non-JSON lines
        }
      }
    });
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
      const stderr = Buffer.concat(errChunks).toString("utf-8");

      // Process any remaining buffered line
      if (lineBuf.trim()) {
        try {
          const event = JSON.parse(lineBuf.trim()) as Record<string, unknown>;
          rawEvents.push(event);
          const classified = classifyEvent(event);
          if (classified.kind === "init") {
            streamSessionId = classified.sessionId;
          }
        } catch {
          // Not JSON
        }
      }

      if (signal === "SIGTERM" || signal === "SIGKILL") {
        session.status = "killed";
        session.completedAt = Date.now();
        session.error = `Killed by signal ${signal}`;
        reject(new Error(`Claude session ${task.sessionId} killed by ${signal}`));
        return;
      }

      const exitCode = code ?? 1;

      // Extract result from collected NDJSON events
      let text = "";
      const resultEvent = rawEvents.findLast(
        (e) => e.type === "result",
      );
      if (resultEvent && typeof resultEvent.result === "string") {
        text = resultEvent.result;
      }

      // Fall back to init session_id if not found in stream
      const claudeSessionId = streamSessionId ?? (rawEvents.find(
        (e) => e.type === "system" && e.subtype === "init",
      )?.session_id as string | undefined);

      const result: ClaudeResult = {
        text: text.trim(),
        raw: rawEvents,
        exitCode,
        duration,
        claudeSessionId,
        usage,
        numTurns,
        compacted: compacted || undefined,
        preCompactTokens,
      };

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
  let claudeSessionId: string | undefined;

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

      // Extract session_id from the init event for session persistence
      const initEvent = parsed.find(
        (e: Record<string, unknown>) => e.type === "system" && e.subtype === "init",
      );
      claudeSessionId = initEvent?.session_id as string | undefined;
    } else if (typeof parsed === "object" && parsed !== null && "result" in parsed) {
      text = String(parsed.result);
    }
  } catch {
    // Not JSON, use raw stdout
  }

  return { text: text.trim(), raw, exitCode, duration, claudeSessionId };
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
