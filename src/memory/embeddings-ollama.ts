import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export type OllamaEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
};

export const DEFAULT_OLLAMA_EMBEDDING_MODEL = "nomic-embed-text";
const DEFAULT_OLLAMA_BASE_URL = "http://localhost:11434";

function normalizeOllamaModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_OLLAMA_EMBEDDING_MODEL;
  }
  return trimmed.startsWith("ollama/") ? trimmed.slice("ollama/".length) : trimmed;
}

function resolveOllamaBaseUrl(remote?: { baseUrl?: string }): string {
  const configured = remote?.baseUrl?.trim();
  if (configured) {
    return configured.replace(/\/+$/, "");
  }
  return (
    process.env.OLLAMA_HOST?.trim() ||
    process.env.OLLAMA_BASE_URL?.trim() ||
    DEFAULT_OLLAMA_BASE_URL
  );
}

function resolveOllamaApiKey(remote?: { apiKey?: string }): string | undefined {
  const configured = remote?.apiKey?.trim();
  if (configured) {
    return configured;
  }
  return process.env.OLLAMA_API_KEY?.trim() || undefined;
}

export async function createOllamaEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: OllamaEmbeddingClient }> {
  const client = resolveOllamaEmbeddingClient(options);
  const embedUrl = `${client.baseUrl.replace(/\/$/, "")}/api/embeddings`;

  const embedOne = async (text: string): Promise<number[]> => {
    const json = await withRemoteHttpResponse({
      url: embedUrl,
      init: {
        method: "POST",
        headers: client.headers,
        body: JSON.stringify({ model: client.model, prompt: text }),
      },
      onResponse: async (res) => {
        if (!res.ok) {
          throw new Error(`Ollama embeddings HTTP ${res.status}: ${await res.text()}`);
        }
        return (await res.json()) as { embedding?: number[] };
      },
    });
    if (!Array.isArray(json.embedding)) {
      throw new Error("Ollama embeddings response missing embedding[]");
    }
    return sanitizeAndNormalizeEmbedding(json.embedding);
  };

  const provider: EmbeddingProvider = {
    id: "ollama",
    model: client.model,
    embedQuery: embedOne,
    embedBatch: async (texts: string[]) => {
      // Ollama /api/embeddings accepts one prompt per request.
      return await Promise.all(texts.map(embedOne));
    },
  };

  return { provider, client };
}

function resolveOllamaEmbeddingClient(
  options: EmbeddingProviderOptions,
): OllamaEmbeddingClient {
  const remote = options.remote;
  const baseUrl = resolveOllamaBaseUrl(remote);
  const model = normalizeOllamaModel(options.model);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...remote?.headers,
  };
  const apiKey = resolveOllamaApiKey(remote);
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }
  return { baseUrl, headers, model };
}
