/**
 * Hybrid search merging vector and keyword results,
 * extracted from OpenClaw.
 */

import { applyMMR, type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
import {
  applyTemporalDecay,
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

export { type MMRConfig, DEFAULT_MMR_CONFIG } from "./mmr.js";
export {
  type TemporalDecayConfig,
  DEFAULT_TEMPORAL_DECAY_CONFIG,
} from "./temporal-decay.js";

export type HybridVectorResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  vectorScore: number;
};

export type HybridKeywordResult = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  textScore: number;
};

type MergedEntry = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  source: string;
  snippet: string;
  vectorScore: number;
  textScore: number;
};

export async function mergeHybridResults(params: {
  vector: HybridVectorResult[];
  keyword: HybridKeywordResult[];
  vectorWeight: number;
  textWeight: number;
  workspaceDir?: string;
  mmr?: Partial<MMRConfig>;
  temporalDecay?: Partial<TemporalDecayConfig>;
  nowMs?: number;
}): Promise<
  Array<{
    path: string;
    startLine: number;
    endLine: number;
    score: number;
    snippet: string;
    source: string;
  }>
> {
  const { vector, keyword, vectorWeight, textWeight } = params;

  // 1. Merge by id, dedup
  const merged = new Map<string, MergedEntry>();

  for (const v of vector) {
    merged.set(v.id, {
      id: v.id,
      path: v.path,
      startLine: v.startLine,
      endLine: v.endLine,
      source: v.source,
      snippet: v.snippet,
      vectorScore: v.vectorScore,
      textScore: 0,
    });
  }

  for (const k of keyword) {
    const existing = merged.get(k.id);
    if (existing) {
      existing.textScore = k.textScore;
      // Keep the snippet from whichever had higher individual score
      if (k.textScore > existing.vectorScore) {
        existing.snippet = k.snippet;
      }
    } else {
      merged.set(k.id, {
        id: k.id,
        path: k.path,
        startLine: k.startLine,
        endLine: k.endLine,
        source: k.source,
        snippet: k.snippet,
        vectorScore: 0,
        textScore: k.textScore,
      });
    }
  }

  // 2. Calculate combined score
  let results = Array.from(merged.values()).map((entry) => ({
    path: entry.path,
    startLine: entry.startLine,
    endLine: entry.endLine,
    score: vectorWeight * entry.vectorScore + textWeight * entry.textScore,
    snippet: entry.snippet,
    source: entry.source,
  }));

  // 3. Apply temporal decay
  const decayConfig: TemporalDecayConfig = {
    ...DEFAULT_TEMPORAL_DECAY_CONFIG,
    ...(params.temporalDecay ?? {}),
  };
  results = await applyTemporalDecay(
    results,
    decayConfig,
    params.workspaceDir,
    params.nowMs,
  );

  // 4. Sort by score desc
  results.sort((a, b) => b.score - a.score);

  // 5. Apply MMR if enabled
  const mmrConfig: Partial<MMRConfig> = {
    ...DEFAULT_MMR_CONFIG,
    ...(params.mmr ?? {}),
  };
  results = applyMMR(results, mmrConfig);

  return results;
}
