/**
 * Query expansion utilities extracted from OpenClaw.
 * English stop words only for v1.
 */

const STOP_WORDS = new Set([
  "a", "an", "the", "this", "that", "these", "those",
  "i", "me", "my", "we", "our", "you", "your",
  "he", "she", "it", "they", "them",
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "can", "may", "might",
  "in", "on", "at", "to", "for", "of", "with", "by", "from",
  "about", "into", "through", "during", "before", "after",
  "above", "below", "between", "under", "over",
  "and", "or", "but", "if", "then", "because", "as", "while",
  "when", "where", "what", "which", "who", "how", "why",
  "yesterday", "today", "tomorrow", "earlier", "later", "recently",
  "ago", "just", "now",
  "thing", "things", "stuff", "something", "anything", "everything", "nothing",
  "please", "help", "find", "show", "get", "tell", "give",
]);

export function isStopWord(token: string): boolean {
  return STOP_WORDS.has(token.toLowerCase());
}

export function extractKeywords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[\s\p{P}]+/u)
    .filter((token) => {
      if (token.length < 2) return false;
      if (/^\d+$/.test(token)) return false;
      if (STOP_WORDS.has(token)) return false;
      return true;
    });
}

export function buildFtsQuery(raw: string): string | null {
  const tokens = Array.from(raw.matchAll(/[\p{L}\p{N}_]+/gu), (m) => m[0]);
  const filtered = tokens.filter(
    (t) => !STOP_WORDS.has(t.toLowerCase()) && t.length >= 2 && !/^\d+$/.test(t),
  );
  if (filtered.length === 0) return null;
  return filtered.map((t) => `"${t}"`).join(" AND ");
}

export function bm25RankToScore(rank: number): number {
  if (rank < 0) {
    const relevance = -rank;
    return relevance / (1 + relevance);
  }
  return 1 / (1 + rank);
}
