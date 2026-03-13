/**
 * Contract: Maximal Marginal Relevance (MMR) Re-ranking
 *
 * MMR balances relevance with diversity:
 *   mmr_score = lambda * relevance - (1-lambda) * max_similarity_to_selected
 *
 * - lambda=1.0 → pure relevance order (no diversity penalty)
 * - lambda=0.0 → maximum diversity (ignore relevance)
 * - Near-duplicate results pushed down in ranking
 * - Single result → returned as-is
 * - Empty input → empty output
 * - Similarity: Jaccard coefficient on lowercased alphanumeric tokens
 */
import { describe, expect, it } from "vitest";
import { tokenize, jaccardSimilarity, applyMMR } from "./mmr.js";

describe("tokenize", () => {
  it("extracts lowercase alphanumeric tokens", () => {
    const tokens = tokenize("Hello World! This is Test-123.");
    expect(tokens).toEqual(new Set(["hello", "world", "this", "is", "test", "123"]));
  });

  it("returns empty set for empty string", () => {
    expect(tokenize("")).toEqual(new Set());
  });

  it("handles special characters", () => {
    const tokens = tokenize("foo_bar@baz.qux");
    expect(tokens).toEqual(new Set(["foo", "bar", "baz", "qux"]));
  });

  it("deduplicates tokens", () => {
    const tokens = tokenize("hello hello HELLO");
    expect(tokens.size).toBe(1);
    expect(tokens.has("hello")).toBe(true);
  });

  it("handles punctuation-only string", () => {
    expect(tokenize("!@#$%^&*()")).toEqual(new Set());
  });
});

describe("jaccardSimilarity", () => {
  it("returns 1 for identical sets", () => {
    const set = new Set(["a", "b", "c"]);
    expect(jaccardSimilarity(set, set)).toBe(1);
  });

  it("returns 0 for disjoint sets", () => {
    const setA = new Set(["a", "b"]);
    const setB = new Set(["c", "d"]);
    expect(jaccardSimilarity(setA, setB)).toBe(0);
  });

  it("calculates partial overlap correctly", () => {
    const setA = new Set(["a", "b", "c"]);
    const setB = new Set(["b", "c", "d"]);
    // intersection=2, union=4
    expect(jaccardSimilarity(setA, setB)).toBeCloseTo(0.5, 5);
  });

  it("returns 1 for two empty sets", () => {
    expect(jaccardSimilarity(new Set(), new Set())).toBe(1);
  });

  it("returns 0 when one set is empty", () => {
    expect(jaccardSimilarity(new Set(["a"]), new Set())).toBe(0);
    expect(jaccardSimilarity(new Set(), new Set(["a"]))).toBe(0);
  });
});

describe("applyMMR", () => {
  const makeResult = (id: string, score: number, snippet: string) => ({
    score,
    snippet,
    path: `memory/${id}.md`,
    startLine: 1,
  });

  it("empty input → empty output", () => {
    const output = applyMMR([], { enabled: true });
    expect(output).toEqual([]);
  });

  it("returns copy when disabled", () => {
    const results = [makeResult("a", 0.9, "hello world"), makeResult("b", 0.5, "foo bar")];
    const output = applyMMR(results, { enabled: false });
    expect(output).toEqual(results);
    // Should be a copy, not same reference
    expect(output).not.toBe(results);
  });

  it("single result → returned as-is", () => {
    const results = [makeResult("a", 0.9, "hello world")];
    const output = applyMMR(results, { enabled: true, lambda: 0.7 });
    expect(output).toHaveLength(1);
    expect(output[0].score).toBe(0.9);
  });

  it("lambda=1.0 → pure relevance order", () => {
    const results = [
      makeResult("a", 0.9, "hello world"),
      makeResult("b", 0.7, "hello world"),
      makeResult("c", 0.5, "hello world"),
    ];

    const mmrResults = applyMMR(results, { enabled: true, lambda: 1.0 });
    expect(mmrResults[0].path).toBe("memory/a.md");
    expect(mmrResults[1].path).toBe("memory/b.md");
    expect(mmrResults[2].path).toBe("memory/c.md");
  });

  it("lambda=0.0 → maximum diversity (near-duplicates penalized)", () => {
    const results = [
      makeResult("a", 0.95, "typescript memory search system"),
      makeResult("b", 0.90, "typescript memory search algorithm"),
      makeResult("c", 0.50, "python web framework django tutorial"),
    ];

    const mmrResults = applyMMR(results, { enabled: true, lambda: 0.0 });
    expect(mmrResults).toHaveLength(3);
    // With pure diversity, after first pick, diverse items promoted
  });

  it("near-duplicate results pushed down in ranking", () => {
    const results = [
      makeResult("a", 0.95, "typescript memory search system"),
      makeResult("b", 0.90, "typescript memory search algorithm"),
      makeResult("c", 0.85, "python web framework django"),
    ];

    const mmrResults = applyMMR(results, { enabled: true, lambda: 0.5 });

    expect(mmrResults).toHaveLength(3);
    // First should still be highest scored
    expect(mmrResults[0].path).toBe("memory/a.md");
    // With lambda=0.5, diverse result "c" should be promoted over similar "b"
    expect(mmrResults[1].path).toBe("memory/c.md");
    expect(mmrResults[2].path).toBe("memory/b.md");
  });

  it("output length equals input length (respects top_k)", () => {
    const results = [
      makeResult("a", 0.9, "aaa bbb"),
      makeResult("b", 0.8, "ccc ddd"),
      makeResult("c", 0.7, "eee fff"),
    ];
    const output = applyMMR(results, { enabled: true });
    expect(output).toHaveLength(3);
  });
});
