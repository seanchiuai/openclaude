/**
 * Memory flush: save durable facts before context compaction.
 *
 * Since openclaude uses the CLI (not direct API), we can't inject silent
 * agentic turns. Instead, shouldFlushMemory() is checked between turns
 * and flushSessionToMemory() writes facts to disk directly.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatSession } from "../router/types.js";

// --- Constants ---

/** Default context window size in tokens. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;

/** Reserve tokens floor — don't flush if below this remaining. */
export const RESERVE_TOKENS_FLOOR = 20_000;

/** Soft threshold — extra margin before compaction triggers. */
export const SOFT_THRESHOLD_TOKENS = 4_000;

/** Flush when input tokens reach this fraction of the effective threshold. */
export const FLUSH_THRESHOLD_RATIO = 0.65;

// --- shouldFlushMemory ---

/**
 * Determines if a memory flush should run before the next user message.
 * Two triggers:
 * 1. Token-based: totalInputTokens approaching context window
 * 2. Compaction-based: auto-compaction happened since last flush
 */
export function shouldFlushMemory(session: ChatSession): boolean {
  // Token-based: total input tokens approaching context window
  const effectiveWindow = DEFAULT_CONTEXT_WINDOW - RESERVE_TOKENS_FLOOR - SOFT_THRESHOLD_TOKENS;
  if (session.totalInputTokens >= effectiveWindow * FLUSH_THRESHOLD_RATIO) {
    return true;
  }

  // Compaction just happened and we haven't flushed since
  const lastFlush = session.lastFlushCompactionCount ?? -1;
  if (session.compactionCount > lastFlush) {
    return true;
  }

  return false;
}

// --- flushSessionToMemory (disk write) ---

export interface FlushDeps {
  memoryDir: string;
  syncFn: () => Promise<void>;
}

export interface FlushResult {
  flushed: boolean;
  path?: string;
}

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Extract key facts from a transcript using simple heuristic.
 * Splits by sentence boundaries, keeps non-trivial sentences (>20 chars).
 */
export function extractKeyFacts(transcript: string): string[] {
  return transcript
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}

/**
 * Write extracted facts from a session transcript to a dated markdown file.
 * Appends to existing file if it exists (never overwrites).
 */
export async function flushSessionToMemory(
  transcript: string,
  deps: FlushDeps,
): Promise<FlushResult> {
  const facts = extractKeyFacts(transcript);
  if (facts.length === 0) {
    return { flushed: false };
  }

  await mkdir(deps.memoryDir, { recursive: true });

  const dateStr = todayDateString();
  const filePath = join(deps.memoryDir, `${dateStr}.md`);

  const factsBlock = facts.map((f) => `- ${f}`).join("\n") + "\n";

  let existing = "";
  try {
    existing = await readFile(filePath, "utf-8");
  } catch {
    // file doesn't exist yet
  }

  if (existing) {
    await writeFile(filePath, existing + "\n" + factsBlock);
  } else {
    const header = `# Session Notes ${dateStr}\n\n`;
    await writeFile(filePath, header + factsBlock);
  }

  await deps.syncFn();

  return { flushed: true, path: filePath };
}
