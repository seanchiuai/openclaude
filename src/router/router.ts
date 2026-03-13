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
import { matchSkillCommand } from "../skills/commands.js";
import type { SkillEntry } from "../skills/loader.js";
import type { McpServerConfig } from "../config/types.js";

export interface RouterDeps extends CommandDeps {
  skills?: SkillEntry[];
  mcpConfig?: Record<string, McpServerConfig>;
  gatewayUrl?: string;
}

export function createRouter(deps: RouterDeps): Router {
  const handlers = createCommandHandlers(deps);
  const pool = deps.pool;
  const skills = deps.skills ?? [];
  const memoryManager = deps.memoryManager;
  const mcpConfig = deps.mcpConfig;
  const gatewayUrl = deps.gatewayUrl;

  // Stable session ID per chat — reused across turns so Claude Code
  // gets the same --project path and can read prior CLAUDE.md / context.
  const mainSessions = new Map<string, string>();

  const toolsLine = gatewayUrl
    ? "\n\nYou have tools to manage this system: cron_add, cron_list, cron_remove, cron_run, cron_status, memory_search, memory_get, send_message. Use them when the user asks you to set reminders, schedule tasks, search memory, or send messages to channels."
    : "";

  async function fetchMemoryContext(query: string): Promise<string | undefined> {
    if (!memoryManager) return undefined;
    try {
      const memories = await memoryManager.search(query, { maxResults: 3 });
      if (memories.length > 0) {
        const memoryContext = memories
          .map(m => `[${m.citation}] (score: ${m.score.toFixed(2)})\n${m.snippet}`)
          .join("\n\n");
        return `You have access to a persistent memory system. Here are relevant memories for this conversation:\n\n${memoryContext}\n\nUse this context to inform your response. If the user asks what you know or remember, reference these memories.${toolsLine}`;
      }
    } catch {
      // Memory search failed, continue without context
    }
    return toolsLine || undefined;
  }

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

    // 2. Check if it matches a loaded skill trigger
    if (message.text.startsWith("/") && skills.length > 0) {
      const skill = matchSkillCommand(message.text, skills);
      if (skill) {
        // Inject the skill body into the prompt sent to Claude Code
        const args = message.text.trim().split(/\s+/).slice(1).join(" ");
        const prompt = args
          ? `${skill.body}\n\nUser request: ${args}`
          : skill.body;

        const sessionKey = deriveSessionKey(message);
        let sessionId = mainSessions.get(sessionKey);
        if (!sessionId) {
          sessionId = `main-${randomUUID().slice(0, 8)}`;
          mainSessions.set(sessionKey, sessionId);
        }

        const systemPrompt = await fetchMemoryContext(prompt);

        try {
          const result = await pool.submit({ sessionId, prompt, systemPrompt, mcpConfig, gatewayUrl });
          return result.text;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // 3. Cron-triggered → isolated session (unique ID each time)
    if (message.source === "cron") {
      const sessionId = `cron-${randomUUID().slice(0, 8)}`;
      try {
        const result = await pool.submit({
          sessionId,
          prompt: message.text,
          timeout: 300_000,
          mcpConfig,
          gatewayUrl,
        });
        return result.text;
      } catch (err) {
        return `Error: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // 4. User message → main session (stable ID per chat)
    const sessionKey = deriveSessionKey(message);
    let sessionId = mainSessions.get(sessionKey);
    if (!sessionId) {
      sessionId = `main-${randomUUID().slice(0, 8)}`;
      mainSessions.set(sessionKey, sessionId);
    }

    const systemPrompt = await fetchMemoryContext(message.text);

    try {
      const result = await pool.submit({
        sessionId,
        prompt: message.text,
        systemPrompt,
        mcpConfig,
        gatewayUrl,
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
