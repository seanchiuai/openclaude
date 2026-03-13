/**
 * Router types for fixed dispatch.
 */
import type { InboundMessage } from "../channels/types.js";

export interface ParsedCommand {
  name: string;
  args: string;
}

export type RouteAction =
  | { type: "gateway_command"; command: ParsedCommand }
  | { type: "main_session"; message: InboundMessage }
  | { type: "isolated_session"; prompt: string };

export type CommandHandler = (
  command: ParsedCommand,
  message: InboundMessage,
) => Promise<string>;

import type { OnStreamEvent } from "../engine/types.js";

export type Router = (message: InboundMessage, onProgress?: OnStreamEvent) => Promise<string>;

export interface ChatSession {
  sessionId: string;        // Internal ID for pool/directory (e.g. "main-abc123")
  claudeSessionId: string;  // UUID for Claude Code --session-id/--resume
  lastMessageAt: number;    // For idle reset
  messageCount: number;     // 0 = first message (use --session-id), 1+ = resume
}
