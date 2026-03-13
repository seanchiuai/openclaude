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
import { readFileSync, writeFileSync } from "node:fs";
import type { ProcessPool } from "../engine/pool.js";
import type { InboundMessage } from "../channels/types.js";
import { GATEWAY_COMMANDS, createCommandHandlers } from "./commands.js";
import type { CommandDeps } from "./commands.js";
import type { ChatSession, ParsedCommand, Router } from "./types.js";
import { matchSkillCommand } from "../skills/commands.js";
import type { SkillEntry } from "../skills/loader.js";
import type { McpServerConfig } from "../config/types.js";
import { paths } from "../config/paths.js";

const IDLE_THRESHOLD = 4 * 60 * 60 * 1000; // 4 hours

function shouldResetSession(session: ChatSession): boolean {
  return Date.now() - session.lastMessageAt > IDLE_THRESHOLD;
}

function saveSessionMap(map: Map<string, ChatSession>): void {
  const data = Object.fromEntries(map);
  writeFileSync(paths.sessionsMap, JSON.stringify(data, null, 2), "utf-8");
}

function loadSessionMap(): Map<string, ChatSession> {
  try {
    const data = JSON.parse(readFileSync(paths.sessionsMap, "utf-8"));
    return new Map(Object.entries(data));
  } catch {
    return new Map();
  }
}

export interface RouterDeps extends CommandDeps {
  skills?: SkillEntry[];
  mcpConfig?: Record<string, McpServerConfig>;
  gatewayUrl?: string;
}

export function createRouter(deps: RouterDeps): Router {
  // Persistent session map: tracks Claude Code session UUIDs per chat
  // for --session-id / --resume continuity across messages.
  const mainSessions = loadSessionMap();

  const handlers = createCommandHandlers({ ...deps, mainSessions, saveSessionMap });
  const pool = deps.pool;
  const skills = deps.skills ?? [];
  const memoryManager = deps.memoryManager;
  const mcpConfig = deps.mcpConfig;
  const gatewayUrl = deps.gatewayUrl;

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
        let chatSession = mainSessions.get(sessionKey);
        if (chatSession && shouldResetSession(chatSession)) {
          mainSessions.delete(sessionKey);
          chatSession = undefined;
        }
        if (!chatSession) {
          chatSession = {
            sessionId: `main-${randomUUID().slice(0, 8)}`,
            claudeSessionId: randomUUID(),
            lastMessageAt: Date.now(),
            messageCount: 0,
          };
          mainSessions.set(sessionKey, chatSession);
        }

        const isResume = chatSession.messageCount > 0;
        const systemPrompt = isResume ? undefined : await fetchMemoryContext(prompt);

        try {
          const result = await pool.submit({
            sessionId: chatSession.sessionId,
            prompt,
            systemPrompt,
            claudeSessionId: chatSession.claudeSessionId,
            resumeSession: isResume,
            mcpConfig,
            gatewayUrl,
          });
          chatSession.messageCount++;
          chatSession.lastMessageAt = Date.now();
          saveSessionMap(mainSessions);
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

    // 4. User message → main session (stable ID per chat, with resume)
    const sessionKey = deriveSessionKey(message);
    let chatSession = mainSessions.get(sessionKey);
    if (chatSession && shouldResetSession(chatSession)) {
      mainSessions.delete(sessionKey);
      chatSession = undefined;
    }
    if (!chatSession) {
      chatSession = {
        sessionId: `main-${randomUUID().slice(0, 8)}`,
        claudeSessionId: randomUUID(),
        lastMessageAt: Date.now(),
        messageCount: 0,
      };
      mainSessions.set(sessionKey, chatSession);
    }

    const isResume = chatSession.messageCount > 0;
    const systemPrompt = isResume ? undefined : await fetchMemoryContext(message.text);

    try {
      const result = await pool.submit({
        sessionId: chatSession.sessionId,
        prompt: message.text,
        systemPrompt,
        claudeSessionId: chatSession.claudeSessionId,
        resumeSession: isResume,
        mcpConfig,
        gatewayUrl,
      });
      chatSession.messageCount++;
      chatSession.lastMessageAt = Date.now();
      saveSessionMap(mainSessions);
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

export { parseCommand, deriveSessionKey, saveSessionMap };
