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
  /** Gateway Bearer token for authenticated MCP gateway calls */
  gatewayToken?: string;
  /** Model override for this task (e.g. 'claude-sonnet-4-6') */
  model?: string;
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  totalCostUsd: number;
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
  /** Token usage from the result event */
  usage?: TokenUsage;
  /** Number of agentic turns (tool-use round trips) */
  numTurns?: number;
  /** True if auto-compaction occurred during this turn */
  compacted?: boolean;
  /** Token count before compaction (from compact_boundary event) */
  preCompactTokens?: number;
}

export interface PoolStats {
  running: number;
  queued: number;
  maxConcurrent: number;
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "status"; message: string }
  | { type: "queued"; position: number }
  | { type: "compaction"; preTokens: number }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd: number };

export type OnStreamEvent = (event: StreamEvent) => void;

export interface SpawnOptions {
  /** Override the claude binary path (default: "claude"). For testing with fake-claude. */
  claudeBinary?: string;
  /** Extra env vars merged into subprocess environment */
  env?: Record<string, string>;
}
