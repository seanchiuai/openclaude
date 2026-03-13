import type { MemorySearchResult } from "../memory/types.js";

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

interface MemoryManager {
  search(
    query: string,
    options: { maxResults: number; minScore: number },
  ): Promise<MemorySearchResult[]>;
  readFile(
    path: string,
    from?: number,
    lines?: number,
  ): Promise<{ text: string }>;
}

export function createMemoryTools(manager: MemoryManager): MemoryTools {
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
