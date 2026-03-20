/**
 * System prompt builder for OpenClaude.
 * Adapted from OpenClaw's src/agents/system-prompt.ts.
 *
 * Assembles prompt sections from editable markdown templates in src/engine/prompts/.
 * Prompt engineers can edit those files directly — changes take effect on next message.
 *
 * Design principles (12 Factor Agents):
 * - Factor 2 (Own Your Prompts): prompts are version-controlled markdown, not buried in code
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
import { loadTemplate } from "./template-loader.js";

const SILENT_REPLY_TOKEN = "NO_REPLY";
const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

/**
 * Controls which sections are included in the system prompt.
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
// Section builders — each returns a string (empty if section should be excluded)
// ---------------------------------------------------------------------------

function buildToolsSection(hasGatewayTools: boolean): string {
  if (!hasGatewayTools) return "";
  return loadTemplate("tools").trimEnd();
}

function buildSkillsSection(skills: SkillEntry[]): string {
  if (skills.length === 0) return "";

  const visible = skills.filter((s) => !s.invocation.disableModelInvocation);
  if (visible.length === 0) return "";

  const skillBlocks = visible.map((s) => {
    const triggers = s.triggers?.map((t) => `/${t.replace(/^\//, "")}`).join(", ") ?? "";
    const header = `### ${s.name}${triggers ? ` (${triggers})` : ""}`;
    const desc = s.description ?? "(no description)";
    return `${header}\n${desc}\n\n${s.body}`;
  });
  return loadTemplate("skills-preamble").trimEnd() + "\n\n" + skillBlocks.join("\n\n");
}

function buildMemorySection(params: {
  memoryContext?: string;
  hasGatewayTools?: boolean;
}): string {
  const parts: string[] = [];

  if (params.hasGatewayTools) {
    parts.push(loadTemplate("memory-recall").trimEnd());
  }

  if (params.memoryContext) {
    parts.push(
      "## Memory Context (auto-loaded)\n" +
      "The following memories were retrieved for this conversation:\n\n" +
      params.memoryContext,
    );
  }

  return parts.join("\n\n");
}

function buildMessagingSection(hasGatewayTools: boolean): string {
  if (!hasGatewayTools) return "";
  return loadTemplate("messaging", { SILENT_REPLY_TOKEN }).trimEnd();
}

function buildReplyTagsSection(): string {
  return loadTemplate("reply-tags").trimEnd();
}

function buildSilentReplySection(): string {
  return loadTemplate("silent-replies", { SILENT_REPLY_TOKEN }).trimEnd();
}

function buildHeartbeatSection(heartbeatPromptLine: string): string {
  return loadTemplate("heartbeats", {
    HEARTBEAT_TOKEN,
    HEARTBEAT_PROMPT: heartbeatPromptLine,
  }).trimEnd();
}

// ---------------------------------------------------------------------------
// Main assembler
// ---------------------------------------------------------------------------

export function buildSystemPrompt(params: SystemPromptParams): string {
  const promptMode = params.promptMode ?? "full";
  const isMinimal = promptMode === "minimal" || promptMode === "none";

  // "none" mode is the smallest possible agent — just identity
  if (promptMode === "none") {
    return loadTemplate("identity").trimEnd();
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

  // Collect sections — empty strings are filtered out before joining
  const sections: string[] = [
    // Identity (always)
    loadTemplate("identity").trimEnd(),
    // Behavior (always)
    loadTemplate("behavior").trimEnd(),
    // Safety (always — non-negotiable)
    loadTemplate("safety").trimEnd(),
    // Tools (always — agent needs to know what it can do)
    buildToolsSection(hasGatewayTools),
    // Skills (full mode only)
    isMinimal ? "" : buildSkillsSection(skills),
    // Memory (full mode only)
    isMinimal ? "" : buildMemorySection({ memoryContext: params.memoryContext, hasGatewayTools }),
    // Workspace (always)
    `## Workspace\nWorking directory: ${workspaceDir}`,
    // Workspace Files note (always)
    "## Workspace Files (injected)\nUser-editable files loaded by OpenClaude appear below in Project Context.",
    // Reply Tags (full mode only)
    isMinimal ? "" : buildReplyTagsSection(),
    // Messaging (full mode only)
    isMinimal ? "" : buildMessagingSection(hasGatewayTools),
    // Silent Replies (full mode only)
    isMinimal ? "" : buildSilentReplySection(),
    // Heartbeats (full mode only)
    isMinimal ? "" : buildHeartbeatSection(heartbeatPromptLine),
  ];

  // Extra context (subagent or additional)
  if (params.extraSystemPrompt?.trim()) {
    const contextHeader = isMinimal ? "## Subagent Context" : "## Additional Context";
    sections.push(`${contextHeader}\n${params.extraSystemPrompt.trim()}`);
  }

  // Project Context (bootstrap files)
  const contextFiles = params.contextFiles ?? [];
  const truncationWarnings = (params.bootstrapTruncationWarnings ?? []).filter(
    (line) => line.trim().length > 0,
  );
  if (contextFiles.length > 0 || truncationWarnings.length > 0) {
    const contextParts: string[] = ["# Project Context"];
    if (contextFiles.length > 0) {
      const hasSoulFile = contextFiles.some((file) => {
        const normalizedPath = file.path.trim().replace(/\\/g, "/");
        const baseName = normalizedPath.split("/").pop() ?? normalizedPath;
        return baseName.toLowerCase() === DEFAULT_SOUL_FILENAME.toLowerCase();
      });
      contextParts.push("The following project context files have been loaded:");
      if (hasSoulFile) {
        contextParts.push("If SOUL.md is present, embody its persona and tone.");
      }
    }
    if (truncationWarnings.length > 0) {
      contextParts.push(
        "Bootstrap truncation warning:\n" +
        truncationWarnings.map((w) => `- ${w}`).join("\n"),
      );
    }
    for (const file of contextFiles) {
      contextParts.push(`## ${file.path}\n\n${file.content}`);
    }
    sections.push(contextParts.join("\n\n"));
  }

  // Runtime (always last — machine-readable metadata)
  sections.push(`## Runtime\n${buildRuntimeLine(channel, params.capabilities, userTimezone)}`);

  return sections.filter(Boolean).join("\n\n");
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
// Child prompt — deliberately narrow: single task, restricted tools,
// no messaging, no spawning. Output goes to parent, not user.
// ---------------------------------------------------------------------------

export function buildChildSystemPrompt(task: string, parentLabel: string): string {
  return loadTemplate("child-agent", { TASK: task, PARENT_LABEL: parentLabel }).trimEnd();
}

export { SILENT_REPLY_TOKEN, HEARTBEAT_TOKEN };
export type { PromptMode as PromptModeType };
