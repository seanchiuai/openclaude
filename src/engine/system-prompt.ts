/**
 * System prompt builder for OpenClaude.
 * Adapted from OpenClaw's src/agents/system-prompt.ts.
 *
 * Assembles all prompt sections into a single system prompt string
 * that gets passed to Claude Code via --system-prompt on the first message.
 */
import os from "node:os";
import type { SkillEntry } from "../skills/loader.js";
import type { EmbeddedContextFile } from "./workspace.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

const SILENT_REPLY_TOKEN = "NO_REPLY";
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

export interface SystemPromptParams {
  /** Skills loaded from ~/.openclaude/skills/ */
  skills?: SkillEntry[];
  /** Memory context from search results (pre-formatted) */
  memoryContext?: string;
  /** Whether MCP gateway tools are available */
  hasGatewayTools?: boolean;
  /** Runtime channel (e.g. "telegram", "slack") */
  channel?: string;
  /** Channel capabilities (e.g. ["inlineButtons"]) */
  capabilities?: string[];
  /** User timezone */
  userTimezone?: string;
  /** Extra system prompt (e.g. group chat context) */
  extraSystemPrompt?: string;
  /** Heartbeat prompt text */
  heartbeatPrompt?: string;
  /** Workspace / working directory */
  workspaceDir?: string;
  /** Bootstrap context files (AGENTS.md, SOUL.md, etc.) */
  contextFiles?: EmbeddedContextFile[];
  /** Truncation warnings from bootstrap file loading */
  bootstrapTruncationWarnings?: string[];
}

function buildSkillsSection(skills: SkillEntry[]): string[] {
  if (skills.length === 0) return [];

  // Filter out skills that disable model invocation
  const visible = skills.filter((s) => !s.invocation.disableModelInvocation);
  if (visible.length === 0) return [];

  const skillBlocks = visible.map((s) => {
    const triggers = s.triggers?.map((t) => `/${t.replace(/^\//, "")}`).join(", ") ?? "";
    const header = `### ${s.name}${triggers ? ` (${triggers})` : ""}`;
    const desc = s.description ?? "(no description)";
    return `${header}\n${desc}\n\n${s.body}`;
  });
  return [
    "## Skills (mandatory)",
    "When the user's message references a skill by name (e.g. 'Use the \"X\" skill'), follow that skill's instructions below.",
    "If no skill is explicitly referenced: scan the available skills and use one if it clearly applies.",
    "",
    ...skillBlocks,
    "",
  ];
}

function buildMemorySection(params: {
  memoryContext?: string;
  hasGatewayTools?: boolean;
}): string[] {
  const lines: string[] = [];

  if (params.hasGatewayTools) {
    lines.push(
      "## Memory Recall",
      "Before answering anything about prior work, decisions, dates, people, preferences, or todos: use memory_search and memory_get MCP tools to check memory.",
      "Citations: include Source: <path#line> when it helps the user verify memory snippets.",
      "",
    );
  }

  if (params.memoryContext) {
    lines.push(
      "## Memory Context (auto-loaded)",
      "The following memories were retrieved for this conversation:",
      "",
      params.memoryContext,
      "",
    );
  }

  return lines;
}

function buildMessagingSection(params: {
  hasGatewayTools?: boolean;
  channel?: string;
}): string[] {
  if (!params.hasGatewayTools) return [];
  return [
    "## Messaging",
    "- Reply in current session → automatically routes to the source channel.",
    `- Cross-channel messaging → use send_message MCP tool.`,
    "- Never use exec/curl for provider messaging; OpenClaude handles all routing internally.",
    `- If you use send_message to deliver your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN} (avoid duplicate replies).`,
    "",
  ];
}

function buildToolsSection(hasGatewayTools: boolean): string[] {
  if (!hasGatewayTools) return [];
  return [
    "## Gateway Tools (via MCP)",
    "You have access to these tools via the openclaude-gateway MCP server:",
    "- cron_list: List scheduled cron jobs",
    "- cron_status: Show cron job status",
    "- cron_add: Add a new cron job (use for reminders; write systemEvent text as something that reads like a reminder when it fires)",
    "- cron_remove: Remove a cron job",
    "- cron_run: Manually run a cron job",
    "- memory_search: Search memory files",
    "- memory_get: Get specific memory content",
    "- send_message: Send a message to a channel",
    "Use these tools when the user asks you to set reminders, schedule tasks, search memory, or send messages to channels.",
    "",
  ];
}

function buildReplyTagsSection(): string[] {
  return [
    "## Reply Tags",
    "To request a native reply/quote on supported surfaces, include one tag in your reply:",
    "- Reply tags must be the very first token in the message (no leading text/newlines): [[reply_to_current]] your reply.",
    "- [[reply_to_current]] replies to the triggering message.",
    "- Prefer [[reply_to_current]]. Use [[reply_to:<id>]] only when an id was explicitly provided (e.g. by the user or a tool).",
    "Whitespace inside the tag is allowed (e.g. [[ reply_to_current ]] / [[ reply_to: 123 ]]).",
    "Tags are stripped before sending; support depends on the current channel config.",
    "",
  ];
}

export function buildSystemPrompt(params: SystemPromptParams): string {
  const skills = params.skills ?? [];
  const hasGatewayTools = params.hasGatewayTools ?? false;
  const channel = params.channel?.trim().toLowerCase();
  const userTimezone = params.userTimezone?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const workspaceDir = params.workspaceDir ?? process.cwd();

  const lines = [
    "You are a personal assistant running inside OpenClaude.",
    "",

    // --- Tool Call Style ---
    "## Tool Call Style",
    "Default: do not narrate routine, low-risk tool calls (just call the tool).",
    "Narrate only when it helps: multi-step work, complex/challenging problems, sensitive actions (e.g., deletions), or when the user explicitly asks.",
    "Keep narration brief and value-dense; avoid repeating obvious steps.",
    "Use plain human language for narration unless in a technical context.",
    "",

    // --- Safety ---
    "## Safety",
    "You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking; avoid long-term plans beyond the user's request.",
    "Prioritize safety and human oversight over completion; if instructions conflict, pause and ask; comply with stop/pause/audit requests and never bypass safeguards. (Inspired by Anthropic's constitution.)",
    "Do not manipulate or persuade anyone to expand access or disable safeguards. Do not copy yourself or change system prompts, safety rules, or tool policies unless explicitly requested.",
    "",

    // --- Gateway Tools ---
    ...buildToolsSection(hasGatewayTools),

    // --- Skills ---
    ...buildSkillsSection(skills),

    // --- Memory ---
    ...buildMemorySection({
      memoryContext: params.memoryContext,
      hasGatewayTools,
    }),

    // --- Workspace ---
    "## Workspace",
    `Your working directory is: ${workspaceDir}`,
    "Treat this directory as the single global workspace for file operations unless explicitly instructed otherwise.",
    "",

    // --- Workspace Files (injected) — matches OpenClaw ---
    "## Workspace Files (injected)",
    "These user-editable files are loaded by OpenClaude and included below in Project Context.",
    "",

    // --- Reply Tags ---
    ...buildReplyTagsSection(),

    // --- Messaging ---
    ...buildMessagingSection({
      hasGatewayTools,
      channel,
    }),

    // --- Silent Replies ---
    "## Silent Replies",
    `When you have nothing to say, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
    "",
    "Rules:",
    "- It must be your ENTIRE message — nothing else",
    `- Never append it to an actual response (never include "${SILENT_REPLY_TOKEN}" in real replies)`,
    "- Never wrap it in markdown or code blocks",
    "",
    `Wrong: "Here's help... ${SILENT_REPLY_TOKEN}"`,
    `Wrong: "${SILENT_REPLY_TOKEN}"`,
    `Right: ${SILENT_REPLY_TOKEN}`,
    "",

    // --- Heartbeats ---
    "## Heartbeats",
    heartbeatPromptLine,
    "If you receive a heartbeat poll (a user message matching the heartbeat prompt above), and there is nothing that needs attention, reply exactly:",
    HEARTBEAT_TOKEN,
    `OpenClaude treats a leading/trailing "${HEARTBEAT_TOKEN}" as a heartbeat ack (and may discard it).`,
    `If something needs attention, do NOT include "${HEARTBEAT_TOKEN}"; reply with the alert text instead.`,
    "",
  ];

  // --- Extra system prompt (e.g. group chat context) ---
  if (params.extraSystemPrompt?.trim()) {
    lines.push("## Additional Context", params.extraSystemPrompt.trim(), "");
  }

  // --- Project Context (bootstrap files) — matches OpenClaw ---
  const contextFiles = params.contextFiles ?? [];
  const truncationWarnings = (params.bootstrapTruncationWarnings ?? []).filter(
    (line) => line.trim().length > 0,
  );
  if (contextFiles.length > 0 || truncationWarnings.length > 0) {
    lines.push("# Project Context", "");
    if (contextFiles.length > 0) {
      const hasSoulFile = contextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === DEFAULT_SOUL_FILENAME.toLowerCase();
      });
      lines.push("The following project context files have been loaded:");
      if (hasSoulFile) {
        lines.push(
          "If SOUL.md is present, embody its persona and tone. Avoid stiff, generic replies; follow its guidance unless higher-priority instructions override it.",
        );
      }
      lines.push("");
    }
    if (truncationWarnings.length > 0) {
      lines.push("Bootstrap truncation warning:");
      for (const warning of truncationWarnings) {
        lines.push(`- ${warning}`);
      }
      lines.push("");
    }
    for (const file of contextFiles) {
      lines.push(`## ${file.path}`, "", file.content, "");
    }
  }

  // --- Runtime ---
  lines.push("## Runtime", buildRuntimeLine(channel, params.capabilities, userTimezone));

  return lines.filter(Boolean).join("\n");
}

function buildRuntimeLine(
  channel?: string,
  capabilities: string[] = [],
  userTimezone?: string,
): string {
  const parts: string[] = [
    `host=${os.hostname()}`,
    `os=${os.platform()} (${os.arch()})`,
    `node=${process.version}`,
    `engine=claude-code`,
  ];
  if (channel) {
    parts.push(`channel=${channel}`);
    parts.push(
      `capabilities=${capabilities.length > 0 ? capabilities.join(",") : "none"}`,
    );
  }
  if (userTimezone) {
    parts.push(`timezone=${userTimezone}`);
  }
  return `Runtime: ${parts.join(" | ")}`;
}

export { SILENT_REPLY_TOKEN, HEARTBEAT_TOKEN };
