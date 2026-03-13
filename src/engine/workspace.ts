/**
 * Workspace bootstrap file loading — adapted from OpenClaw's src/agents/workspace.ts
 * and src/agents/pi-embedded-helpers/bootstrap.ts.
 *
 * Loads user-editable workspace files (AGENTS.md, SOUL.md, etc.) from ~/.openclaude/
 * and builds them into context files for system prompt injection.
 */
import { readFileSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { paths } from "../config/paths.js";

// --- Bootstrap file names (matches OpenClaw) ---

const DEFAULT_AGENTS_FILENAME = "AGENTS.md";
const DEFAULT_SOUL_FILENAME = "SOUL.md";
const DEFAULT_TOOLS_FILENAME = "TOOLS.md";
const DEFAULT_IDENTITY_FILENAME = "IDENTITY.md";
const DEFAULT_USER_FILENAME = "USER.md";
const DEFAULT_HEARTBEAT_FILENAME = "HEARTBEAT.md";
const DEFAULT_BOOTSTRAP_FILENAME = "BOOTSTRAP.md";
const DEFAULT_MEMORY_FILENAME = "MEMORY.md";
const DEFAULT_MEMORY_ALT_FILENAME = "memory.md";

/** Ordered list of workspace files to load. */
const BOOTSTRAP_FILE_NAMES = [
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
  DEFAULT_HEARTBEAT_FILENAME,
  DEFAULT_BOOTSTRAP_FILENAME,
  DEFAULT_MEMORY_FILENAME,
  DEFAULT_MEMORY_ALT_FILENAME,
];

/** Minimal set for cron/subagent sessions (matches OpenClaw's filterBootstrapFilesForSession). */
const MINIMAL_BOOTSTRAP_NAMES = new Set([
  DEFAULT_AGENTS_FILENAME,
  DEFAULT_TOOLS_FILENAME,
  DEFAULT_SOUL_FILENAME,
  DEFAULT_IDENTITY_FILENAME,
  DEFAULT_USER_FILENAME,
]);

// --- Size limits (matches OpenClaw defaults) ---

const MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per file
const DEFAULT_BOOTSTRAP_MAX_CHARS = 20_000; // Per-file char limit
const DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS = 150_000; // Total budget
const BOOTSTRAP_HEAD_RATIO = 0.7;
const BOOTSTRAP_TAIL_RATIO = 0.2;

// --- Types ---

export interface WorkspaceBootstrapFile {
  name: string;
  path: string;
  content?: string;
  missing: boolean;
}

export interface EmbeddedContextFile {
  path: string;
  content: string;
}

// --- Loading ---

/**
 * Load workspace bootstrap files from ~/.openclaude/.
 * Matches OpenClaw's loadWorkspaceBootstrapFiles().
 */
export function loadWorkspaceBootstrapFiles(
  dir?: string,
): WorkspaceBootstrapFile[] {
  const workspaceDir = dir ?? paths.base;
  const seen = new Set<string>();
  const files: WorkspaceBootstrapFile[] = [];

  for (const name of BOOTSTRAP_FILE_NAMES) {
    const filePath = join(workspaceDir, name);

    // Deduplicate (MEMORY.md vs memory.md on case-insensitive fs)
    const normalizedName = name.toLowerCase();
    if (seen.has(normalizedName)) continue;

    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        files.push({ name, path: filePath, missing: true });
        continue;
      }
      if (stat.size > MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES) {
        files.push({
          name,
          path: filePath,
          content: `[File too large: ${stat.size} bytes, max ${MAX_WORKSPACE_BOOTSTRAP_FILE_BYTES}]`,
          missing: false,
        });
        seen.add(normalizedName);
        continue;
      }
      const content = readFileSync(filePath, "utf-8");
      files.push({ name, path: filePath, content, missing: false });
      seen.add(normalizedName);
    } catch {
      files.push({ name, path: filePath, missing: true });
    }
  }

  return files;
}

/**
 * Filter bootstrap files for minimal context (cron/subagent sessions).
 * Matches OpenClaw's filterBootstrapFilesForSession().
 */
export function filterBootstrapFilesForMinimal(
  files: WorkspaceBootstrapFile[],
): WorkspaceBootstrapFile[] {
  return files.filter((f) => MINIMAL_BOOTSTRAP_NAMES.has(f.name));
}

// --- Context file building (truncation) ---

/**
 * Truncate content with head/tail strategy.
 * Matches OpenClaw's bootstrap.ts truncation logic.
 */
function truncateContent(
  content: string,
  maxChars: number,
  fileName: string,
): string {
  if (content.length <= maxChars) return content;

  const headChars = Math.floor(maxChars * BOOTSTRAP_HEAD_RATIO);
  const tailChars = Math.floor(maxChars * BOOTSTRAP_TAIL_RATIO);
  const head = content.slice(0, headChars);
  const tail = content.slice(-tailChars);
  const marker = `\n[...truncated, read ${fileName} for full content...]\n`;
  return head + marker + tail;
}

/**
 * Build context files from workspace bootstrap files with truncation.
 * Matches OpenClaw's buildBootstrapContextFiles().
 */
export function buildBootstrapContextFiles(
  files: WorkspaceBootstrapFile[],
  options?: {
    fileMaxChars?: number;
    totalMaxChars?: number;
  },
): { contextFiles: EmbeddedContextFile[]; truncationWarnings: string[] } {
  const fileMaxChars = options?.fileMaxChars ?? DEFAULT_BOOTSTRAP_MAX_CHARS;
  const totalMaxChars = options?.totalMaxChars ?? DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS;
  const contextFiles: EmbeddedContextFile[] = [];
  const truncationWarnings: string[] = [];
  let totalChars = 0;

  for (const file of files) {
    if (file.missing || !file.content) continue;

    let content = file.content;

    // Per-file truncation
    if (content.length > fileMaxChars) {
      content = truncateContent(content, fileMaxChars, file.name);
      truncationWarnings.push(
        `${file.name} was truncated from ${file.content.length} to ${fileMaxChars} chars`,
      );
    }

    // Total budget enforcement
    const remaining = totalMaxChars - totalChars;
    if (remaining <= 0) {
      truncationWarnings.push(
        `${file.name} skipped: total bootstrap budget (${totalMaxChars} chars) exceeded`,
      );
      continue;
    }
    if (content.length > remaining) {
      content = content.slice(0, remaining) + "…";
      truncationWarnings.push(
        `${file.name} clamped to fit remaining budget (${remaining} chars)`,
      );
    }

    totalChars += content.length;
    contextFiles.push({ path: file.name, content });
  }

  return { contextFiles, truncationWarnings };
}

export {
  BOOTSTRAP_FILE_NAMES,
  MINIMAL_BOOTSTRAP_NAMES,
  DEFAULT_BOOTSTRAP_MAX_CHARS,
  DEFAULT_BOOTSTRAP_TOTAL_MAX_CHARS,
  DEFAULT_SOUL_FILENAME,
};
