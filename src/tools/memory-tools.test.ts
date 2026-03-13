/**
 * Contract tests for src/tools/memory-tools.ts
 *
 * This module exposes memory operations as agent tools.
 *
 * Expected interface:
 *   interface MemoryTools {
 *     memory_search(params: {
 *       query: string;
 *       maxResults?: number;
 *       minScore?: number;
 *     }): Promise<MemorySearchResult[]>;
 *
 *     memory_get(params: {
 *       path: string;
 *       from?: number;
 *       lines?: number;
 *     }): Promise<{ text: string }>;
 *   }
 *
 * The implementation module does not exist yet. These tests define the
 * contract that the memory tools must satisfy once implemented.
 * The memory manager is fully mocked.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import type { MemorySearchResult } from "../memory/types.js";

// ---------------------------------------------------------------------------
// Types mirroring the contract
// ---------------------------------------------------------------------------
interface MemorySearchParams {
  query: string;
  maxResults?: number;
  minScore?: number;
}

interface MemoryGetParams {
  path: string;
  from?: number;
  lines?: number;
}

interface MemoryTools {
  memory_search(params: MemorySearchParams): Promise<MemorySearchResult[]>;
  memory_get(params: MemoryGetParams): Promise<{ text: string }>;
}

// ---------------------------------------------------------------------------
// Mock memory manager
// ---------------------------------------------------------------------------
interface MockMemoryManager {
  search: ReturnType<typeof vi.fn>;
  readFile: ReturnType<typeof vi.fn>;
}

function createMockManager(): MockMemoryManager {
  return {
    search: vi.fn(),
    readFile: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Mock implementation — stands in until the real module exists.
// ---------------------------------------------------------------------------
function createMemoryTools(manager: MockMemoryManager): MemoryTools {
  return {
    async memory_search(params: MemorySearchParams): Promise<MemorySearchResult[]> {
      if (!params.query || params.query.trim() === "") {
        return [];
      }

      const maxResults = params.maxResults ?? 10;
      const minScore = params.minScore ?? 0;

      const results: MemorySearchResult[] = await manager.search(
        params.query,
        { maxResults, minScore },
      );

      return results
        .filter((r) => r.score >= minScore)
        .slice(0, maxResults);
    },

    async memory_get(params: MemoryGetParams): Promise<{ text: string }> {
      const result = await manager.readFile(
        params.path,
        params.from,
        params.lines,
      );
      return { text: result.text };
    },
  };
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------
function makeSearchResults(count: number): MemorySearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `memory/note-${i}.md`,
    startLine: 1,
    endLine: 10,
    score: 1.0 - i * 0.1,
    snippet: `Result snippet ${i} with relevant content.`,
    source: "memory" as const,
    citation: `memory/note-${i}.md#L1-L10`,
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("memory_search", () => {
  let manager: MockMemoryManager;
  let tools: MemoryTools;

  beforeEach(() => {
    manager = createMockManager();
    tools = createMemoryTools(manager);
  });

  it("returns ranked results with scores", async () => {
    const mockResults = makeSearchResults(5);
    manager.search.mockResolvedValue(mockResults);

    const results = await tools.memory_search({ query: "test query" });

    expect(results).toHaveLength(5);
    // Results should be ranked by score (descending)
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
    // Each result should have required fields
    for (const r of results) {
      expect(r).toHaveProperty("path");
      expect(r).toHaveProperty("score");
      expect(r).toHaveProperty("snippet");
      expect(r).toHaveProperty("source");
      expect(typeof r.score).toBe("number");
    }
  });

  it("respects maxResults (top_k)", async () => {
    const mockResults = makeSearchResults(10);
    manager.search.mockResolvedValue(mockResults.slice(0, 3));

    const results = await tools.memory_search({
      query: "test query",
      maxResults: 3,
    });

    expect(results).toHaveLength(3);
    expect(manager.search).toHaveBeenCalledWith("test query", {
      maxResults: 3,
      minScore: 0,
    });
  });

  it("empty query returns empty results", async () => {
    const results = await tools.memory_search({ query: "" });

    expect(results).toEqual([]);
    // Should not even call the manager for empty queries
    expect(manager.search).not.toHaveBeenCalled();
  });

  it("minScore filters low-score results", async () => {
    const mockResults = makeSearchResults(5);
    // Results have scores: 1.0, 0.9, 0.8, 0.7, 0.6
    manager.search.mockResolvedValue(mockResults);

    const results = await tools.memory_search({
      query: "test query",
      minScore: 0.75,
    });

    // Should only include results with score >= 0.75
    expect(results.length).toBe(3);
    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0.75);
    }
  });
});

describe("memory_get", () => {
  let manager: MockMemoryManager;
  let tools: MemoryTools;

  beforeEach(() => {
    manager = createMockManager();
    tools = createMemoryTools(manager);
  });

  it("returns full content by path", async () => {
    const fileContent = "# Notes\n\nSome important memory content.\nLine four.\n";
    manager.readFile.mockResolvedValue({
      text: fileContent,
      path: "MEMORY.md",
    });

    const result = await tools.memory_get({ path: "MEMORY.md" });

    expect(result.text).toBe(fileContent);
    expect(manager.readFile).toHaveBeenCalledWith(
      "MEMORY.md",
      undefined,
      undefined,
    );
  });

  it("nonexistent path propagates error", async () => {
    manager.readFile.mockRejectedValue(
      new Error("File not found: nonexistent.md"),
    );

    await expect(
      tools.memory_get({ path: "nonexistent.md" }),
    ).rejects.toThrow("File not found");
  });
});
