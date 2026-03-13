/**
 * Types for the Claude Code CLI engine.
 */

export interface AgentTask {
  sessionId: string;
  prompt: string;
  workingDirectory?: string;
  timeout?: number;
  systemPrompt?: string;
  mcpConfig?: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
  /** Gateway HTTP URL for auto-injected MCP server (e.g. http://localhost:45557) */
  gatewayUrl?: string;
}

export type SessionStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "killed";

export interface ClaudeSession {
  id: string;
  projectPath: string;
  pid: number | undefined;
  status: SessionStatus;
  startedAt: number;
  completedAt?: number;
  timeout: number;
  result?: ClaudeResult;
  error?: string;
}

export interface ClaudeResult {
  /** The text output from Claude */
  text: string;
  /** Raw JSON output if available */
  raw?: unknown;
  /** Exit code of the process */
  exitCode: number;
  /** Duration in milliseconds */
  duration: number;
}

export interface PoolStats {
  running: number;
  queued: number;
  maxConcurrent: number;
}
