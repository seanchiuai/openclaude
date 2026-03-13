/**
 * Fixed router for OpenClaude.
 * Simplified from OpenClaw's routing/resolve-route.ts.
 *
 * Static dispatch table:
 * - /commands → handled directly in gateway
 * - user messages → main session via Claude Code engine
 * - cron jobs → isolated session
 */
import { randomUUID } from "node:crypto";
import type { ProcessPool } from "../engine/pool.js";
import type { InboundMessage } from "../channels/types.js";
import { GATEWAY_COMMANDS, createCommandHandlers } from "./commands.js";
import type { CommandDeps } from "./commands.js";
import type { ParsedCommand, Router } from "./types.js";

export function createRouter(deps: CommandDeps): Router {
  const handlers = createCommandHandlers(deps);
  const pool = deps.pool;

  // Stable session ID per chat — reused across turns so Claude Code
  // gets the same --project path and can read prior CLAUDE.md / context.
  const mainSessions = new Map<string, string>();

  return async (message: InboundMessage): Promise<string> => {
    // 1. Parse commands
    if (message.text.startsWith("/")) {
      const command = parseCommand(message.text);
      if (GATEWAY_COMMANDS.has(command.name)) {
        const handler = handlers[command.name];
        if (handler) {
          return handler(command);
        }
      }
    }

    // 2. Cron-triggered → isolated session (unique ID each time)
    if (message.source === "cron") {
      const sessionId = `cron-${randomUUID().slice(0, 8)}`;
      try {
        const result = await pool.submit({
          sessionId,
          prompt: message.text,
          timeout: 300_000,
        });
        return result.text;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 3. User message → main session (stable ID per chat)
    const sessionKey = deriveSessionKey(message);
    let sessionId = mainSessions.get(sessionKey);
    if (!sessionId) {
      sessionId = `main-${randomUUID().slice(0, 8)}`;
      mainSessions.set(sessionKey, sessionId);
    }

    try {
      const result = await pool.submit({
        sessionId,
        prompt: message.text,
      });
      return result.text;
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}

function parseCommand(text: string): ParsedCommand {
  // Handle /command@botname format
  const match = text.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?\s*(.*)/s);
  if (!match) {
    return { name: "", args: "" };
  }
  return { name: match[1].toLowerCase(), args: match[2] };
}

function deriveSessionKey(message: InboundMessage): string {
  return `${message.channel}:${message.chatId}`;
}

export { parseCommand, deriveSessionKey };
