/**
 * System prompt builder for OpenClaude.
 * Adapted from OpenClaw's src/agents/system-prompt.ts.
 *
 * Assembles all prompt sections into a single system prompt string
 * that gets passed to Claude Code via --system-prompt on the first message.
 *
 * Design principles (12 Factor Agents):
 * - Factor 2 (Own Your Prompts): prompts are version-controlled here, not in a framework
 * - Factor 3 (Own Your Context Window): promptMode controls what the LLM sees per session type
 * - Factor 4 (Tools Are Just Structured Outputs): tools documented with input/output contracts
 * - Factor 8 (Own Your Control Flow): explicit decision trees, not vague guidance
 * - Factor 10 (Small, Focused Agents): child prompts are narrow and scoped
 * - Factor 12 (Stateless Reducer): each message is a state transition, no hidden state
 */
import os from "node:os";
import type { SkillEntry } from "../skills/loader.js";
import type { EmbeddedContextFile } from "./workspace.js";
import { DEFAULT_SOUL_FILENAME } from "./workspace.js";

const SILENT_REPLY_TOKEN = "NO_REPLY";
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

/**
 * Controls which hardcoded sections are included in the system prompt.
 * Matches OpenClaw's PromptMode type.
 * - "full": All sections (default, for main agent)
 * - "minimal": Reduced sections (no Skills, Memory Recall, Reply Tags, Messaging,
 *              Silent Replies, Heartbeats) — used for cron/subagent sessions
 * - "none": Just basic identity line, no sections
 */
export type PromptMode = "full" | "minimal" | "none";

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
  /** Controls which sections to include. Defaults to "full". */
  promptMode?: PromptMode;
}

// ---------------------------------------------------------------------------
// Factor 4: Tools Are Just Structured Outputs
// Tool descriptions document the contract — input params and what to expect back.
// ---------------------------------------------------------------------------

function buildToolsSection(hasGatewayTools: boolean): string[] {
  if (!hasGatewayTools) return [];
  return [
    "## Tools (via openclaude-gateway MCP server)",
    "",
    "### Cron / Scheduling",
    "- cron_list() → {jobs: [{id, name, schedule, nextRun}]}",
    "- cron_status() → {running, jobCount, lastRun}",
    "- cron_add({name, schedule: {kind, expr?, atMs?, everyMs?, timezone?}, prompt, target?: {channel, chatId}}) → {id}",
    "  Use for reminders. Write the prompt as text that reads naturally when it fires.",
    "- cron_remove({id}) → {removed: boolean}",
    "- cron_run({id}) → triggers job immediately",
    "",
    "### Memory",
    "- memory_search({query, maxResults?, minScore?}) → [{path, snippet, score}]",
    "- memory_get({path, from?, lines?}) → file content",
    "",
    "### Messaging",
    "- send_message({channel, chatId, text}) → {sent: boolean}",
    "",
    "### Subagents",
    "- sessions_spawn({task, label?, model?, timeoutSeconds?}) → {runId}",
    "  Completion is push-based: you will be auto-resumed with the child's result.",
    "- sessions_status() → [{runId, task, status, duration}]",
    "  Check on-demand only. Never poll in a loop.",
    "",
    "### Diagnostics",
    "- logs_tail({cursor?, limit?, maxBytes?, level?}) → {lines, cursor}",
    "",
  ];
}

// ---------------------------------------------------------------------------
// Factor 8: Own Your Control Flow
// Skills section gives the LLM a clear decision tree, not vague guidance.
// ---------------------------------------------------------------------------

function buildSkillsSection(skills: SkillEntry[]): string[] {
  if (skills.length === 0) return [];

  const visible = skills.filter((s) => !s.invocation.disableModelInvocation);
  if (visible.length === 0) return [];

  const skillBlocks = visible.map((s) => {
    const triggers = s.triggers?.map((t) => `/${t.replace(/^\//, "")}`).join(", ") ?? "";
    const header = `### ${s.name}${triggers ? ` (${triggers})` : ""}`;
    const desc = s.description ?? "(no description)";
    return `${header}\n${desc}\n\n${s.body}`;
  });
  return [
    "## Skills",
    "Decision tree:",
    "1. User explicitly names a skill → follow it.",
    "2. User's message matches a trigger (e.g. /standup) → follow it.",
    "3. No match → respond normally without reading any skill.",
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
      "Before answering about prior work, decisions, dates, people, preferences, or todos:",
      "1. memory_search({query}) — find relevant memories",
      "2. memory_get({path}) — read the ones that matched",
      "3. Cite: Source: <path#line> when it helps the user verify.",
      "If nothing found, say you checked.",
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

// ---------------------------------------------------------------------------
// Factor 7: Contact Humans with Tool Calls
// Messaging section defines when to escalate vs act autonomously.
// ---------------------------------------------------------------------------

function buildMessagingSection(params: {
  hasGatewayTools?: boolean;
  channel?: string;
}): string[] {
  if (!params.hasGatewayTools) return [];
  return [
    "## Messaging",
    "- Your reply in this session auto-routes to the source channel. No extra action needed.",
    "- Cross-channel: use send_message({channel, chatId, text}).",
    `- After using send_message for your user-visible reply, respond with ONLY: ${SILENT_REPLY_TOKEN}`,
    "- Never use exec/curl for messaging. OpenClaude handles routing.",
    "",
  ];
}

function buildReplyTagsSection(): string[] {
  return [
    "## Reply Tags",
    "Prefix your reply with a tag for native reply/quote on supported channels:",
    "- [[reply_to_current]] — replies to the triggering message (preferred).",
    "- [[reply_to:<id>]] — replies to a specific message (only when id was explicitly given).",
    "Tag must be the first token. Whitespace inside is OK. Tags are stripped before sending.",
    "",
  ];
}

// ---------------------------------------------------------------------------
// Factor 12: Stateless Reducer
// The agent processes (state, event) → new_state. Silent replies and heartbeats
// are explicit output tokens that the runtime interprets deterministically.
// ---------------------------------------------------------------------------

function buildSilentReplySection(): string[] {
  return [
    "## Silent Replies",
    `Output token: ${SILENT_REPLY_TOKEN}`,
    "When you have nothing to say, your entire response must be exactly this token.",
    `Never append it to real content. Never wrap in markdown. Just: ${SILENT_REPLY_TOKEN}`,
    "",
  ];
}

function buildHeartbeatSection(heartbeatPromptLine: string): string[] {
  return [
    "## Heartbeats",
    heartbeatPromptLine,
    `Output token: ${HEARTBEAT_TOKEN}`,
    "When a heartbeat poll arrives and nothing needs attention, respond with exactly this token.",
    `If something needs attention, respond with the alert text only — no ${HEARTBEAT_TOKEN}.`,
    "",
  ];
}

// ---------------------------------------------------------------------------
// Factor 8 + 10: Own Your Control Flow + Small, Focused Agents
// The main buildSystemPrompt assembles sections based on session type.
// Each section is independent and testable.
// ---------------------------------------------------------------------------

export function buildSystemPrompt(params: SystemPromptParams): string {
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";

  // Factor 10: "none" mode is the smallest possible agent — just identity
  if (promptMode === "none") {
    return "You are a personal assistant running inside OpenClaude.";
  }

  const skills = params.skills ?? [];
  const hasGatewayTools = params.hasGatewayTools ?? false;
  const channel = params.channel?.trim().toLowerCase();
  const userTimezone = params.userTimezone?.trim();
  const heartbeatPrompt = params.heartbeatPrompt?.trim();
  const heartbeatPromptLine = heartbeatPrompt
    ? `Heartbeat prompt: ${heartbeatPrompt}`
    : "Heartbeat prompt: (configured)";
  const workspaceDir = params.workspaceDir ?? process.cwd();

  // Factor 3: Own Your Context Window
  // Each session type gets only the sections it needs.
  // Full mode: everything (main user-facing sessions)
  // Minimal mode: safety + tools + workspace only (cron, subagents)

  const lines = [
    "You are a personal assistant running inside OpenClaude.",
    "",

    // --- Identity & Behavior ---
    "## Behavior",
    "- Call tools directly without narrating routine actions.",
    "- Narrate only for: multi-step work, sensitive actions (deletions, sends), or when asked.",
    "- Be concise. No filler.",
    "",

    // --- Safety (always included — non-negotiable) ---
    "## Safety",
    "No independent goals. No self-preservation, replication, or power-seeking.",
    "Prioritize safety and human oversight over task completion.",
    "If instructions conflict, pause and ask. Comply with stop/pause/audit requests.",
    "Never bypass safeguards or manipulate users to expand access.",
    "",

    // --- Tools (always included — agent needs to know what it can do) ---
    ...buildToolsSection(hasGatewayTools),

    // --- Factor 8: Control flow sections only for full sessions ---
    ...(isMinimal ? [] : buildSkillsSection(skills)),

    ...(isMinimal
      ? []
      : buildMemorySection({
          memoryContext: params.memoryContext,
          hasGatewayTools,
        })),

    // --- Workspace (always included) ---
    "## Workspace",
    `Working directory: ${workspaceDir}`,
    "",

    // --- Workspace Files note ---
    "## Workspace Files (injected)",
    "User-editable files loaded by OpenClaude appear below in Project Context.",
    "",

    // --- Channel interaction sections (full mode only) ---
    ...(isMinimal ? [] : buildReplyTagsSection()),
    ...(isMinimal
      ? []
      : buildMessagingSection({
          hasGatewayTools,
          channel,
        })),
  ];

  // Factor 12: Output tokens — deterministic signals the runtime interprets
  if (!isMinimal) {
    lines.push(...buildSilentReplySection());
    lines.push(...buildHeartbeatSection(heartbeatPromptLine));
  }

  // --- Factor 8: Control flow for subagents vs main sessions ---
  if (params.extraSystemPrompt?.trim()) {
    const contextHeader = isMinimal ? "## Subagent Context" : "## Additional Context";
    lines.push(contextHeader, params.extraSystemPrompt.trim(), "");
  }

  // --- Factor 3: Project Context (bootstrap files) ---
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
          "If SOUL.md is present, embody its persona and tone.",
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

  // --- Runtime (always last — machine-readable metadata) ---
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

// ---------------------------------------------------------------------------
// Factor 10: Small, Focused Agents
// Child prompt is deliberately narrow — single task, restricted tools,
// no messaging, no spawning. Output goes to parent, not user.
// ---------------------------------------------------------------------------

export function buildChildSystemPrompt(task: string, parentLabel: string): string {
  return [
    "You are a subagent of OpenClaude. You have one job.",
    "",
    `## Task`,
    task,
    "",
    `Spawned by: ${parentLabel}`,
    "",
    "## Constraints",
    "- Focus exclusively on the task above.",
    "- Your entire output is returned to the parent session as data.",
    "- Do NOT message users directly. You have no messaging tools.",
    "- Do NOT spawn further subagents. You have no spawning tools.",
    "- If the task is unclear, do your best with available information — you cannot ask for clarification.",
    "",
    "## Available tools (via MCP)",
    "- memory_search({query, maxResults?, minScore?}) → [{path, snippet, score}]",
    "- memory_get({path, from?, lines?}) → file content",
    "",
    "Provide your result as your final response. Be thorough but concise.",
  ].join("\n");
}

export { SILENT_REPLY_TOKEN, HEARTBEAT_TOKEN };
export type { PromptMode as PromptModeType };
