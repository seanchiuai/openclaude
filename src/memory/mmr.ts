/**
 * Maximal Marginal Relevance (MMR) re-ranking for diversity,
 * extracted from OpenClaw.
 */

export type MMRConfig = {
  enabled: boolean;
  lambda: number;
};

export const DEFAULT_MMR_CONFIG: MMRConfig = {
  enabled: false,
  lambda: 0.7,
};

export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z0-9]+/g)) {
    tokens.add(match[0]);
  }
  return tokens;
}

export function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  const smaller = setA.size <= setB.size ? setA : setB;
  const larger = setA.size <= setB.size ? setB : setA;

  for (const token of smaller) {
    if (larger.has(token)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

export function applyMMR<
  T extends { score: number; snippet: string; path: string; startLine: number },
>(results: T[], config: Partial<MMRConfig>): T[] {
  const enabled = config.enabled ?? DEFAULT_MMR_CONFIG.enabled;
  const lambda = config.lambda ?? DEFAULT_MMR_CONFIG.lambda;

  if (!enabled || results.length <= 1) {
    return [...results];
  }

  // Pre-tokenize all snippets
  const tokenCache = new Map<number, Set<string>>();
  for (let i = 0; i < results.length; i++) {
    tokenCache.set(i, tokenize(results[i].snippet));
  }

  // Normalize scores to [0, 1]
  const scores = results.map((r) => r.score);
  const maxScore = Math.max(...scores);
  const minScore = Math.min(...scores);
  const scoreRange = maxScore - minScore;

  function normalizedScore(idx: number): number {
    if (scoreRange === 0) return 1;
    return (results[idx].score - minScore) / scoreRange;
  }

  const selected: number[] = [];
  const remaining = new Set(results.map((_, i) => i));

  // First pick: highest score
  let bestIdx = 0;
  let bestScore = -Infinity;
  for (const idx of remaining) {
    const ns = normalizedScore(idx);
    if (ns > bestScore) {
      bestScore = ns;
      bestIdx = idx;
    }
  }
  selected.push(bestIdx);
  remaining.delete(bestIdx);

  // Iteratively select remaining
  while (remaining.size > 0) {
    let bestMMR = -Infinity;
    let bestCandidate = -1;

    for (const candidateIdx of remaining) {
      const relevance = normalizedScore(candidateIdx);
      const candidateTokens = tokenCache.get(candidateIdx)!;

      // Max similarity to already selected
      let maxSim = 0;
      for (const selectedIdx of selected) {
        const selectedTokens = tokenCache.get(selectedIdx)!;
        const sim = jaccardSimilarity(candidateTokens, selectedTokens);
        if (sim > maxSim) maxSim = sim;
      }

      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMR) {
        bestMMR = mmrScore;
        bestCandidate = candidateIdx;
      }
    }

    selected.push(bestCandidate);
    remaining.delete(bestCandidate);
  }

  return selected.map((idx) => ({ ...results[idx] }));
}
