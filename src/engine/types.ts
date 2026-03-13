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
  /** Claude Code session UUID — used with --session-id or --resume */
  claudeSessionId?: string;
  /** If true, resume an existing session instead of creating a new one */
  resumeSession?: boolean;
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
  /** Claude Code session UUID extracted from the init event */
  claudeSessionId?: string;
}

export interface PoolStats {
  running: number;
  queued: number;
  maxConcurrent: number;
}
