/**
 * Contract: Hybrid Search Merging
 *
 * mergeHybridResults merges vector and keyword search results:
 * - Applies vectorWeight (0.7) and textWeight (0.3) to respective scores
 * - Deduplicates results by ID
 * - Sorts by combined score descending
 * - Pure keyword fallback when no vector results exist
 * - Empty inputs → empty output
 * - All scores in combined results are in [0, 1] range
 *
 * buildFtsQuery: converts search query to FTS5 AND expression
 * bm25RankToScore: converts BM25 rank to 0-1 score
 * extractKeywords: removes stop words, returns meaningful tokens
 */
import { describe, expect, it } from "vitest";
import { mergeHybridResults } from "./hybrid.js";
import { buildFtsQuery, bm25RankToScore, extractKeywords } from "./query-expansion.js";

describe("mergeHybridResults", () => {
  it("merges vector and keyword results with correct weights (0.7/0.3)", async () => {
    const vector = [
      { id: "a", path: "memory/notes.md", startLine: 1, endLine: 5, source: "memory", snippet: "vector snippet a", vectorScore: 0.9 },
      { id: "b", path: "memory/log.md", startLine: 10, endLine: 15, source: "memory", snippet: "vector snippet b", vectorScore: 0.5 },
    ];
    const keyword = [
      { id: "a", path: "memory/notes.md", startLine: 1, endLine: 5, source: "memory", snippet: "keyword snippet a", textScore: 0.3 },
      { id: "c", path: "memory/other.md", startLine: 20, endLine: 25, source: "memory", snippet: "keyword snippet c", textScore: 0.8 },
    ];

    const results = await mergeHybridResults({
      vector,
      keyword,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    // Should have 3 unique results (a, b, c) — deduplicated
    expect(results).toHaveLength(3);

    // Result "a" should combine both scores: 0.7*0.9 + 0.3*0.3 = 0.72
    const resultA = results.find((r) => r.path === "memory/notes.md");
    expect(resultA).toBeDefined();
    expect(resultA!.score).toBeCloseTo(0.72, 5);

    // Result "b" should only have vector: 0.7*0.5 + 0.3*0 = 0.35
    const resultB = results.find((r) => r.path === "memory/log.md");
    expect(resultB).toBeDefined();
    expect(resultB!.score).toBeCloseTo(0.35, 5);

    // Result "c" should only have keyword: 0.7*0 + 0.3*0.8 = 0.24
    const resultC = results.find((r) => r.path === "memory/other.md");
    expect(resultC).toBeDefined();
    expect(resultC!.score).toBeCloseTo(0.24, 5);
  });

  it("sorts results descending by score", async () => {
    const vector = [
      { id: "low", path: "a.md", startLine: 1, endLine: 1, source: "memory", snippet: "low", vectorScore: 0.1 },
      { id: "high", path: "b.md", startLine: 1, endLine: 1, source: "memory", snippet: "high", vectorScore: 0.9 },
    ];

    const results = await mergeHybridResults({
      vector,
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    expect(results[0].score).toBeGreaterThanOrEqual(results[1].score);
  });

  it("deduplicates results across vector and keyword hits", async () => {
    const vector = [
      { id: "same", path: "doc.md", startLine: 1, endLine: 5, source: "memory", snippet: "vector text", vectorScore: 0.8 },
    ];
    const keyword = [
      { id: "same", path: "doc.md", startLine: 1, endLine: 5, source: "memory", snippet: "keyword text", textScore: 0.6 },
    ];

    const results = await mergeHybridResults({
      vector,
      keyword,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    // Should have only 1 result (deduplicated by ID)
    expect(results).toHaveLength(1);
    // Combined score: 0.7*0.8 + 0.3*0.6 = 0.56 + 0.18 = 0.74
    expect(results[0].score).toBeCloseTo(0.74, 5);
  });

  it("pure keyword fallback when no vector results exist", async () => {
    const keyword = [
      { id: "k1", path: "notes.md", startLine: 1, endLine: 5, source: "memory", snippet: "keyword hit", textScore: 0.9 },
    ];

    const results = await mergeHybridResults({
      vector: [],
      keyword,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    expect(results).toHaveLength(1);
    // Only keyword score: 0.3 * 0.9 = 0.27
    expect(results[0].score).toBeCloseTo(0.27, 5);
  });

  it("returns empty array for empty inputs", async () => {
    const results = await mergeHybridResults({
      vector: [],
      keyword: [],
      vectorWeight: 0.7,
      textWeight: 0.3,
    });
    expect(results).toEqual([]);
  });

  it("all scores are non-negative", async () => {
    const vector = [
      { id: "a", path: "a.md", startLine: 1, endLine: 1, source: "memory", snippet: "text", vectorScore: 0.5 },
    ];
    const keyword = [
      { id: "b", path: "b.md", startLine: 1, endLine: 1, source: "memory", snippet: "text", textScore: 0.3 },
    ];

    const results = await mergeHybridResults({
      vector,
      keyword,
      vectorWeight: 0.7,
      textWeight: 0.3,
    });

    for (const r of results) {
      expect(r.score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("buildFtsQuery", () => {
  it("builds AND query from tokens", () => {
    const result = buildFtsQuery("typescript memory search");
    expect(result).toBe('"typescript" AND "memory" AND "search"');
  });

  it("returns null for empty or stop-word-only input", () => {
    expect(buildFtsQuery("")).toBeNull();
    expect(buildFtsQuery("the a an")).toBeNull();
    expect(buildFtsQuery("is are was")).toBeNull();
  });

  it("strips stop words and keeps meaningful tokens", () => {
    const result = buildFtsQuery("find the memory about typescript");
    expect(result).toBe('"memory" AND "typescript"');
  });

  it("filters pure numbers and short tokens", () => {
    expect(buildFtsQuery("a 1 23 x")).toBeNull();
  });
});

describe("bm25RankToScore", () => {
  it("converts negative rank to score in 0-1 range", () => {
    const score = bm25RankToScore(-5);
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
    expect(score).toBeCloseTo(5 / 6, 5);
  });

  it("higher negative magnitude gives higher score", () => {
    const scoreHigh = bm25RankToScore(-10);
    const scoreLow = bm25RankToScore(-2);
    expect(scoreHigh).toBeGreaterThan(scoreLow);
  });

  it("converts positive rank using 1/(1+rank)", () => {
    expect(bm25RankToScore(0)).toBe(1);
    expect(bm25RankToScore(1)).toBeCloseTo(0.5, 5);
    expect(bm25RankToScore(3)).toBeCloseTo(0.25, 5);
  });
});

describe("extractKeywords", () => {
  it("removes stop words and returns keywords", () => {
    const keywords = extractKeywords("find the memory about typescript");
    expect(keywords).toEqual(["memory", "typescript"]);
  });

  it("returns empty array for all stop words", () => {
    expect(extractKeywords("the a an is are")).toEqual([]);
  });

  it("lowercases and filters short tokens", () => {
    const keywords = extractKeywords("TypeScript x Memory A");
    expect(keywords).toEqual(["typescript", "memory"]);
  });

  it("filters pure numbers", () => {
    const keywords = extractKeywords("version 123 typescript");
    expect(keywords).toEqual(["version", "typescript"]);
  });
});
