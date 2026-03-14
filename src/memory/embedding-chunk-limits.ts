import { estimateUtf8Bytes, splitTextToUtf8ByteLimit } from "./embedding-input-limits.js";
import { resolveEmbeddingMaxInputTokens } from "./embedding-model-limits.js";
import { hashText } from "./internal.js";

// TODO: Import these types from their canonical modules once ported.
// EmbeddingProvider from embeddings.ts, MemoryChunk from internal.ts (with embeddingInput field),
// EmbeddingInput and hasNonTextEmbeddingParts from embedding-inputs.ts.
type EmbeddingProvider = { id: string; model: string; maxInputTokens?: number };
type EmbeddingInput = { text: string; parts?: Array<{ type: string; text?: string; mimeType?: string; data?: string }> };
type MemoryChunkWithEmbedding = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: EmbeddingInput;
};

function hasNonTextEmbeddingParts(input: EmbeddingInput | undefined): boolean {
  if (!input?.parts?.length) {
    return false;
  }
  return input.parts.some((part) => part.type === "inline-data");
}

export function enforceEmbeddingMaxInputTokens(
  provider: EmbeddingProvider,
  chunks: MemoryChunkWithEmbedding[],
  hardMaxInputTokens?: number,
): MemoryChunkWithEmbedding[] {
  const providerMaxInputTokens = resolveEmbeddingMaxInputTokens(provider);
  const maxInputTokens =
    typeof hardMaxInputTokens === "number" && hardMaxInputTokens > 0
      ? Math.min(providerMaxInputTokens, hardMaxInputTokens)
      : providerMaxInputTokens;
  const out: MemoryChunkWithEmbedding[] = [];

  for (const chunk of chunks) {
    if (hasNonTextEmbeddingParts(chunk.embeddingInput)) {
      out.push(chunk);
      continue;
    }
    if (estimateUtf8Bytes(chunk.text) <= maxInputTokens) {
      out.push(chunk);
      continue;
    }

    for (const text of splitTextToUtf8ByteLimit(chunk.text, maxInputTokens)) {
      out.push({
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        text,
        hash: hashText(text),
        embeddingInput: { text },
      });
    }
  }

  return out;
}
