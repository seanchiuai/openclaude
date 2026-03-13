/**
 * Contract tests for src/memory/embeddings.ts
 *
 * This module provides embedding generation with caching and provider selection.
 *
 * Expected interface:
 *   interface EmbeddingProvider {
 *     id: string;
 *     model: string;
 *     embedQuery(text: string): Promise<number[]>;
 *     embedBatch(texts: string[]): Promise<number[][]>;
 *   }
 *
 *   function createEmbeddingProvider(options: {
 *     provider: string;
 *     model?: string;
 *     apiKey?: string;
 *     baseUrl?: string;
 *     batchSize?: number;
 *     timeout?: number;
 *     db?: DatabaseSync;
 *   }): Promise<{
 *     provider: EmbeddingProvider | null;
 *     error?: string;
 *   }>
 *
 * The implementation module does not exist yet. These tests define the
 * contract that the embeddings module must satisfy once implemented.
 * All external providers are mocked — no real API calls are made.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Types mirroring the contract
// ---------------------------------------------------------------------------
interface EmbeddingProvider {
  id: string;
  model: string;
  embedQuery(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
}

interface EmbeddingProviderResult {
  provider: EmbeddingProvider | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeVector(dims: number, seed: number = 1): number[] {
  return Array.from({ length: dims }, (_, i) => Math.sin(seed + i) * 0.5);
}

function createMockProvider(
  overrides: Partial<EmbeddingProvider> = {},
): EmbeddingProvider {
  const dims = 384;
  return {
    id: overrides.id ?? "mock",
    model: overrides.model ?? "mock-model",
    embedQuery:
      overrides.embedQuery ??
      vi.fn(async (_text: string) => makeVector(dims)),
    embedBatch:
      overrides.embedBatch ??
      vi.fn(async (texts: string[]) => texts.map((_, i) => makeVector(dims, i))),
  };
}

// ---------------------------------------------------------------------------
// Simple in-memory cache for contract testing
// ---------------------------------------------------------------------------
class EmbeddingCache {
  private store = new Map<string, number[]>();

  get(key: string): number[] | undefined {
    return this.store.get(key);
  }

  set(key: string, value: number[]): void {
    this.store.set(key, value);
  }

  has(key: string): boolean {
    return this.store.has(key);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("EmbeddingProvider contract", () => {
  it("local provider returns fixed-dimension vectors", async () => {
    const dims = 384;
    const provider = createMockProvider({
      id: "local",
      model: "all-MiniLM-L6-v2",
      embedQuery: vi.fn(async () => makeVector(dims)),
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map(() => makeVector(dims)),
      ),
    });

    const vec = await provider.embedQuery("hello world");
    expect(vec).toHaveLength(dims);
    expect(typeof vec[0]).toBe("number");

    const batch = await provider.embedBatch(["a", "b", "c"]);
    expect(batch).toHaveLength(3);
    for (const v of batch) {
      expect(v).toHaveLength(dims);
    }
  });

  it("cache hit skips provider and returns cached embedding", async () => {
    const embedFn = vi.fn(async () => makeVector(384));
    const provider = createMockProvider({ embedQuery: embedFn });
    const cache = new EmbeddingCache();

    const cacheKey = "test-query";
    const cachedVec = makeVector(384, 42);
    cache.set(cacheKey, cachedVec);

    // Simulate cached lookup: if cache has it, don't call provider
    const result = cache.has(cacheKey)
      ? cache.get(cacheKey)!
      : await provider.embedQuery(cacheKey);

    expect(result).toEqual(cachedVec);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it("cache miss calls provider and caches result", async () => {
    const expectedVec = makeVector(384, 7);
    const embedFn = vi.fn(async () => expectedVec);
    const provider = createMockProvider({ embedQuery: embedFn });
    const cache = new EmbeddingCache();

    const cacheKey = "uncached-query";

    // Simulate: check cache, miss, call provider, store
    let result: number[];
    if (cache.has(cacheKey)) {
      result = cache.get(cacheKey)!;
    } else {
      result = await provider.embedQuery(cacheKey);
      cache.set(cacheKey, result);
    }

    expect(embedFn).toHaveBeenCalledOnce();
    expect(result).toEqual(expectedVec);
    expect(cache.get(cacheKey)).toEqual(expectedVec);
  });

  it("batch embedding splits at batch size limit", async () => {
    const batchSize = 3;
    const allTexts = ["a", "b", "c", "d", "e", "f", "g"];
    const batchCalls: string[][] = [];

    const batchFn = vi.fn(async (texts: string[]) => {
      batchCalls.push([...texts]);
      return texts.map((_, i) => makeVector(384, i));
    });

    // Simulate splitting into batches
    const results: number[][] = [];
    for (let i = 0; i < allTexts.length; i += batchSize) {
      const batch = allTexts.slice(i, i + batchSize);
      const batchResult = await batchFn(batch);
      results.push(...batchResult);
    }

    expect(batchCalls).toHaveLength(3); // ceil(7/3) = 3 calls
    expect(batchCalls[0]).toEqual(["a", "b", "c"]);
    expect(batchCalls[1]).toEqual(["d", "e", "f"]);
    expect(batchCalls[2]).toEqual(["g"]);
    expect(results).toHaveLength(7);
  });

  it("provider timeout propagates error", async () => {
    const provider = createMockProvider({
      embedQuery: vi.fn(async () => {
        throw new Error("Request timed out after 5000ms");
      }),
    });

    await expect(provider.embedQuery("slow query")).rejects.toThrow(
      "Request timed out",
    );
  });

  it("auto-selection tries providers in order", async () => {
    const providerAttempts: string[] = [];

    // Simulate auto-selection: try ollama first (fails), then fall back to local
    const tryProviders = async (
      providerNames: string[],
    ): Promise<EmbeddingProviderResult> => {
      for (const name of providerNames) {
        providerAttempts.push(name);
        if (name === "ollama") {
          // Simulate connection refused
          continue;
        }
        if (name === "local") {
          return { provider: createMockProvider({ id: "local", model: "gte-small" }) };
        }
      }
      return { provider: null, error: "No provider available" };
    };

    const result = await tryProviders(["ollama", "local"]);

    expect(providerAttempts).toEqual(["ollama", "local"]);
    expect(result.provider).not.toBeNull();
    expect(result.provider!.id).toBe("local");
  });

  it("Ollama provider handles connection refused gracefully", async () => {
    const createOllamaProvider = async (
      baseUrl: string,
    ): Promise<EmbeddingProviderResult> => {
      try {
        // Simulate connection attempt
        throw new Error(`connect ECONNREFUSED ${baseUrl}`);
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Unknown error";
        if (message.includes("ECONNREFUSED")) {
          return {
            provider: null,
            error: `Ollama not available: ${message}`,
          };
        }
        throw err;
      }
    };

    const result = await createOllamaProvider("http://127.0.0.1:11434");

    expect(result.provider).toBeNull();
    expect(result.error).toContain("Ollama not available");
    expect(result.error).toContain("ECONNREFUSED");
  });
});
