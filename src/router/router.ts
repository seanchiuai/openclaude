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
import type { OnStreamEvent, ClaudeResult } from "../engine/types.js";
import type { ChatSession, ParsedCommand, Router } from "./types.js";
import {
  buildSkillCommandSpecs,
  resolveSkillCommandInvocation,
} from "../skills/commands.js";
import type { SkillCommandSpec } from "../skills/commands.js";
import type { SkillEntry } from "../skills/loader.js";
import type { McpServerConfig } from "../config/types.js";
import { paths } from "../config/paths.js";
import { buildSystemPrompt } from "../engine/system-prompt.js";
import { shouldFlushMemory, flushSessionToMemory } from "../memory/memory-flush.js";
import {
  loadWorkspaceBootstrapFiles,
  buildBootstrapContextFiles,
  filterBootstrapFilesForMinimal,
  ensureAgentWorkspace,
} from "../engine/workspace.js";

const IDLE_THRESHOLD = 4 * 60 * 60 * 1000; // 4 hours

function shouldResetSession(session: ChatSession): boolean {
  return Date.now() - session.lastMessageAt > IDLE_THRESHOLD;
}

function createChatSession(sessionId: string): ChatSession {
  return {
    sessionId,
    claudeSessionId: randomUUID(),
    lastMessageAt: Date.now(),
    messageCount: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCostUsd: 0,
    compactionCount: 0,
  };
}

function updateSessionUsage(session: ChatSession, result: ClaudeResult): void {
  if (result.usage) {
    session.totalInputTokens += result.usage.inputTokens;
    session.totalOutputTokens += result.usage.outputTokens;
    session.totalCostUsd += result.usage.totalCostUsd;
  }
  if (result.compacted) {
    session.compactionCount++;
    session.lastCompactedAt = Date.now();
  }
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
  gatewayToken?: string;
}

export function createRouter(deps: RouterDeps): Router {
  // Persistent session map: tracks Claude Code session UUIDs per chat
  // for --session-id / --resume continuity across messages.
  const mainSessions = loadSessionMap();

  const handlers = createCommandHandlers(deps);
  const pool = deps.pool;
  const skills = deps.skills ?? [];
  const memoryManager = deps.memoryManager;
  const mcpConfig = deps.mcpConfig;
  const gatewayUrl = deps.gatewayUrl;
  const gatewayToken = deps.gatewayToken;

  // Build command specs from loaded skills (matches OpenClaw's buildWorkspaceSkillCommandSpecs)
  const skillCommands: SkillCommandSpec[] = buildSkillCommandSpecs(
    skills,
    GATEWAY_COMMANDS,
  );

  // Ensure workspace files exist on startup (matches OpenClaw's ensureAgentWorkspace)
  ensureAgentWorkspace();

  async function fetchMemoryContext(query: string): Promise<string | undefined> {
    if (!memoryManager) return undefined;
    try {
      const memories = await memoryManager.search(query, { maxResults: 3 });
      if (memories.length > 0) {
        return memories
          .map(m => `[${m.citation}] (score: ${m.score.toFixed(2)})\n${m.snippet}`)
          .join("\n\n");
      }
    } catch {
      // Memory search failed, continue without context
    }
    return undefined;
  }

  function buildSystemPromptForSession(params: {
    memoryContext?: string;
    channel: string;
    minimal?: boolean;
  }): string {
    // Load workspace bootstrap files (cached by inode/mtime)
    const allBootstrapFiles = loadWorkspaceBootstrapFiles();
    const bootstrapFiles = params.minimal
      ? filterBootstrapFilesForMinimal(allBootstrapFiles)
      : allBootstrapFiles;
    const { contextFiles, truncationWarnings } = buildBootstrapContextFiles(bootstrapFiles);

    return buildSystemPrompt({
      skills,
      memoryContext: params.memoryContext,
      hasGatewayTools: !!gatewayUrl,
      channel: params.channel,
      workspaceDir: process.cwd(),
      contextFiles,
      bootstrapTruncationWarnings: truncationWarnings,
      // Cron/subagent sessions use minimal mode: skip Skills, Memory Recall,
      // Reply Tags, Messaging, Silent Replies, Heartbeats (matches OpenClaw)
      promptMode: params.minimal ? "minimal" : "full",
    });
  }

  async function buildFirstMessageSystemPrompt(
    query: string,
    message: InboundMessage,
  ): Promise<string> {
    const memoryContext = await fetchMemoryContext(query);
    return buildSystemPromptForSession({
      memoryContext,
      channel: message.channel,
    });
  }

  return async (message: InboundMessage, onProgress?: OnStreamEvent): Promise<string> => {
    // 0. /reset needs message context to scope to calling chat
    if (message.text.startsWith("/")) {
      const command = parseCommand(message.text);
      if (command.name === "reset") {
        const sessionKey = deriveSessionKey(message);
        const deleted = mainSessions.delete(sessionKey);
        saveSessionMap(mainSessions);
        return deleted
          ? "Session reset. Next message will start a fresh Claude Code session."
          : "No active session for this chat.";
      }

      // /stop — handled here (not in generic command handler) so we have
      // access to message context and can resolve the session automatically.
      if (command.name === "stop") {
        const explicitId = command.args.trim();
        if (explicitId) {
          // Explicit session ID provided
          const killed = pool.killSession(explicitId);
          return killed
            ? `Session ${explicitId} stopped.`
            : `Session ${explicitId} not found.`;
        }

        // No args → stop the current chat's session
        const sessionKey = deriveSessionKey(message);
        const chatSession = mainSessions.get(sessionKey);
        if (!chatSession) {
          return "No active session for this chat.";
        }

        const killed = pool.killSession(chatSession.sessionId);
        return killed
          ? "Stopped."
          : "No running task for this chat.";
      }

      // 1. Parse commands
      if (GATEWAY_COMMANDS.has(command.name)) {
        const handler = handlers[command.name];
        if (handler) {
          return handler(command);
        }
      }
    }

    // 2. Check if it matches a loaded skill trigger (OpenClaw-style resolution)
    if (message.text.startsWith("/") && skillCommands.length > 0) {
      const invocation = resolveSkillCommandInvocation({
        commandBodyNormalized: message.text,
        skillCommands,
      });
      if (invocation) {
        // Find the full skill entry for system prompt injection
        const skill = skills.find(
          (s) => s.name === invocation.command.skillName,
        );

        // OpenClaw-style prompt: rewrite body to reference skill + user input
        const promptParts = [
          `Use the "${invocation.command.skillName}" skill for this request.`,
          invocation.args ? `User input:\n${invocation.args}` : null,
        ].filter((entry): entry is string => Boolean(entry));
        const prompt = promptParts.join("\n\n");

        const sessionKey = deriveSessionKey(message);
        let chatSession = mainSessions.get(sessionKey);
        if (chatSession && shouldResetSession(chatSession)) {
          mainSessions.delete(sessionKey);
          chatSession = undefined;
        }
        if (!chatSession) {
          chatSession = createChatSession(`main-${randomUUID().slice(0, 8)}`);
          mainSessions.set(sessionKey, chatSession);
        }

        const isResume = chatSession.messageCount > 0;
        // Skill body is injected via the system prompt (skills section),
        // matching how OpenClaw's agent framework makes skill definitions available.
        const systemPrompt = isResume ? undefined : await buildFirstMessageSystemPrompt(
          invocation.args ?? invocation.command.skillName,
          message,
        );

        try {
          const result = await pool.submit({
            sessionId: chatSession.sessionId,
            prompt,
            systemPrompt,
            claudeSessionId: chatSession.claudeSessionId,
            resumeSession: isResume,
            mcpConfig,
            gatewayUrl,
            gatewayToken,
          }, onProgress);
          chatSession.messageCount++;
          chatSession.lastMessageAt = Date.now();
          updateSessionUsage(chatSession, result);
          // Update stored session ID if CLI returned a different one (OpenClaw parity)
          if (result.claudeSessionId && result.claudeSessionId !== chatSession.claudeSessionId) {
            chatSession.claudeSessionId = result.claudeSessionId;
          }
          saveSessionMap(mainSessions);
          return result.text;
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      }
    }

    // 3. Cron-triggered → isolated session with minimal bootstrap (matches OpenClaw)
    if (message.source === "cron") {
      const sessionId = `cron-${randomUUID().slice(0, 8)}`;
      const systemPrompt = buildSystemPromptForSession({
        channel: message.channel,
        minimal: true,
      });
      try {
        const result = await pool.submit({
          sessionId,
          prompt: message.text,
          systemPrompt,
          timeout: 300_000,
          mcpConfig,
          gatewayUrl,
          gatewayToken,
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
      chatSession = createChatSession(`main-${randomUUID().slice(0, 8)}`);
      mainSessions.set(sessionKey, chatSession);
    }

    // Pre-turn memory flush: save durable facts before context compaction loses them
    if (shouldFlushMemory(chatSession)) {
      const syncFn = memoryManager?.sync ? () => memoryManager.sync!() : async () => {};
      try {
        await flushSessionToMemory(
          `Session ${chatSession.sessionId} has used ${chatSession.totalInputTokens} input tokens. Compaction count: ${chatSession.compactionCount}.`,
          { memoryDir: paths.memory, syncFn },
        );
        chatSession.lastFlushCompactionCount = chatSession.compactionCount;
        saveSessionMap(mainSessions);
      } catch {
        // Memory flush is best-effort; don't block the user message
      }
    }

    const isResume = chatSession.messageCount > 0;
    const systemPrompt = isResume ? undefined : await buildFirstMessageSystemPrompt(message.text, message);

    try {
      const result = await pool.submit({
        sessionId: chatSession.sessionId,
        prompt: message.text,
        systemPrompt,
        claudeSessionId: chatSession.claudeSessionId,
        resumeSession: isResume,
        mcpConfig,
        gatewayUrl,
        gatewayToken,
      }, onProgress);
      chatSession.messageCount++;
      chatSession.lastMessageAt = Date.now();
      updateSessionUsage(chatSession, result);
      // Update stored session ID if CLI returned a different one (OpenClaw parity)
      if (result.claudeSessionId && result.claudeSessionId !== chatSession.claudeSessionId) {
        chatSession.claudeSessionId = result.claudeSessionId;
      }
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
