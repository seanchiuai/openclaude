/**
 * Contract tests for src/memory/memory-flush.ts
 *
 * This module extracts key facts from a session transcript and writes
 * them to a dated markdown file in the memory directory, then triggers a sync.
 *
 * Expected interface:
 *   interface FlushDeps {
 *     memoryDir: string;
 *     syncFn: () => Promise<void>;
 *   }
 *   function flushSessionToMemory(
 *     transcript: string,
 *     deps: FlushDeps,
 *   ): Promise<{ flushed: boolean; path?: string }>
 *
 * The implementation module does not exist yet. These tests define the
 * contract that flushSessionToMemory must satisfy once implemented.
 * Uses real temp directories for file operations.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";

// ---------------------------------------------------------------------------
// Types mirroring the contract
// ---------------------------------------------------------------------------
interface FlushDeps {
  memoryDir: string;
  syncFn: () => Promise<void>;
}

interface FlushResult {
  flushed: boolean;
  path?: string;
}

// ---------------------------------------------------------------------------
// Mock implementation — stands in until the real module exists.
// ---------------------------------------------------------------------------

function todayDateString(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function extractKeyFacts(transcript: string): string[] {
  // Minimal extraction: split by sentences, keep non-trivial ones.
  // The real implementation would use an LLM or heuristic NLP.
  const sentences = transcript
    .split(/[.!?\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
  return sentences;
}

async function flushSessionToMemory(
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

  // Build content to append
  const factsBlock = facts.map((f) => `- ${f}`).join("\n") + "\n";

  // Append to existing file or create new one
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("flushSessionToMemory", () => {
  let tmpDir: string;
  let memoryDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-flush-test-"));
    memoryDir = join(tmpDir, "memory");
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("extracts key facts from session transcript and writes to file", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "The user asked about quantum computing applications in drug discovery. " +
      "We discussed how quantum simulations can model molecular interactions. " +
      "The conclusion was to explore Qiskit for initial experiments.";

    const result = await flushSessionToMemory(transcript, {
      memoryDir,
      syncFn,
    });

    expect(result.flushed).toBe(true);
    expect(result.path).toBeDefined();

    const content = await readFile(result.path!, "utf-8");
    expect(content.length).toBeGreaterThan(0);
    // Should contain structured facts
    expect(content).toContain("-");
  });

  it("writes to memory/YYYY-MM-DD.md dated file", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "Today we configured the deployment pipeline for the staging environment. " +
      "The database migration strategy was finalized using blue-green deployments.";

    const result = await flushSessionToMemory(transcript, {
      memoryDir,
      syncFn,
    });

    expect(result.flushed).toBe(true);
    expect(result.path).toBeDefined();

    // Path should match YYYY-MM-DD.md pattern
    const filename = result.path!.split("/").pop()!;
    expect(filename).toMatch(/^\d{4}-\d{2}-\d{2}\.md$/);
    expect(result.path!.startsWith(memoryDir)).toBe(true);
  });

  it("triggers sync after write (syncFn called)", async () => {
    const syncFn = vi.fn(async () => {});
    const transcript =
      "We implemented the authentication middleware using JWT tokens with refresh rotation. " +
      "Rate limiting was added at 100 requests per minute per user.";

    await flushSessionToMemory(transcript, { memoryDir, syncFn });

    expect(syncFn).toHaveBeenCalledOnce();
  });

  it("empty/trivial session returns flushed: false", async () => {
    const syncFn = vi.fn(async () => {});

    // Empty transcript
    const result1 = await flushSessionToMemory("", { memoryDir, syncFn });
    expect(result1.flushed).toBe(false);
    expect(result1.path).toBeUndefined();

    // Trivial transcript (too short to extract facts)
    const result2 = await flushSessionToMemory("ok thanks bye", {
      memoryDir,
      syncFn,
    });
    expect(result2.flushed).toBe(false);
    expect(result2.path).toBeUndefined();

    // syncFn should not be called when nothing is flushed
    expect(syncFn).not.toHaveBeenCalled();
  });

  it("appends to existing date file, does not overwrite", async () => {
    const syncFn = vi.fn(async () => {});

    const firstTranscript =
      "The first session covered setting up the project structure and dependencies. " +
      "We chose pnpm as the package manager for workspace support.";

    const secondTranscript =
      "The second session focused on writing integration tests for the API layer. " +
      "Coverage targets were set at eighty percent for critical paths.";

    // First flush
    const result1 = await flushSessionToMemory(firstTranscript, {
      memoryDir,
      syncFn,
    });
    expect(result1.flushed).toBe(true);
    const contentAfterFirst = await readFile(result1.path!, "utf-8");

    // Second flush (same day)
    const result2 = await flushSessionToMemory(secondTranscript, {
      memoryDir,
      syncFn,
    });
    expect(result2.flushed).toBe(true);
    expect(result2.path).toBe(result1.path); // same date file

    const contentAfterSecond = await readFile(result2.path!, "utf-8");

    // Should contain content from both sessions
    expect(contentAfterSecond.length).toBeGreaterThan(contentAfterFirst.length);
    // Original content should still be present (not overwritten)
    expect(contentAfterSecond).toContain("project structure");
    expect(contentAfterSecond).toContain("integration tests");
  });
});
