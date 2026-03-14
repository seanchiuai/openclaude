import { sanitizeAndNormalizeEmbedding } from "./embedding-vectors.js";
import type { EmbeddingProvider, EmbeddingProviderOptions } from "./embeddings.js";
import { withRemoteHttpResponse } from "./remote-http.js";

export type GeminiEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  model: string;
  modelPath: string;
  apiKey: string;
  outputDimensionality?: number;
};

const DEFAULT_GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_EMBEDDING_MODEL = "gemini-embedding-001";
const GEMINI_MAX_INPUT_TOKENS: Record<string, number> = {
  "text-embedding-004": 2048,
};

// --- gemini-embedding-2-preview support ---

export const GEMINI_EMBEDDING_2_MODELS = new Set([
  "gemini-embedding-2-preview",
]);

const GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS = 3072;
const GEMINI_EMBEDDING_2_VALID_DIMENSIONS = [768, 1536, 3072] as const;

export type GeminiTaskType =
  | "RETRIEVAL_QUERY"
  | "RETRIEVAL_DOCUMENT"
  | "SEMANTIC_SIMILARITY"
  | "CLASSIFICATION"
  | "CLUSTERING"
  | "QUESTION_ANSWERING"
  | "FACT_VERIFICATION";

export type GeminiTextEmbeddingRequest = {
  content: { parts: Array<{ text: string }> };
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  model?: string;
};

/** Builds the text-only Gemini embedding request shape. */
export function buildGeminiTextEmbeddingRequest(params: {
  text: string;
  taskType: GeminiTaskType;
  outputDimensionality?: number;
  modelPath?: string;
}): GeminiTextEmbeddingRequest {
  const request: GeminiTextEmbeddingRequest = {
    content: { parts: [{ text: params.text }] },
    taskType: params.taskType,
  };
  if (params.modelPath) {
    request.model = params.modelPath;
  }
  if (params.outputDimensionality != null) {
    request.outputDimensionality = params.outputDimensionality;
  }
  return request;
}

/**
 * Returns true if the given model name is a gemini-embedding-2 variant that
 * supports `outputDimensionality` and extended task types.
 */
export function isGeminiEmbedding2Model(model: string): boolean {
  return GEMINI_EMBEDDING_2_MODELS.has(model);
}

/**
 * Validate and return the `outputDimensionality` for gemini-embedding-2 models.
 * Returns `undefined` for older models (they don't support the param).
 */
export function resolveGeminiOutputDimensionality(
  model: string,
  requested?: number,
): number | undefined {
  if (!isGeminiEmbedding2Model(model)) {
    return undefined;
  }
  if (requested == null) {
    return GEMINI_EMBEDDING_2_DEFAULT_DIMENSIONS;
  }
  const valid: readonly number[] = GEMINI_EMBEDDING_2_VALID_DIMENSIONS;
  if (!valid.includes(requested)) {
    throw new Error(
      `Invalid outputDimensionality ${requested} for ${model}. Valid values: ${valid.join(", ")}`,
    );
  }
  return requested;
}

export function normalizeGeminiModel(model: string): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return DEFAULT_GEMINI_EMBEDDING_MODEL;
  }
  const withoutPrefix = trimmed.replace(/^models\//, "");
  if (withoutPrefix.startsWith("gemini/")) {
    return withoutPrefix.slice("gemini/".length);
  }
  if (withoutPrefix.startsWith("google/")) {
    return withoutPrefix.slice("google/".length);
  }
  return withoutPrefix;
}

async function fetchGeminiEmbeddingPayload(params: {
  client: GeminiEmbeddingClient;
  endpoint: string;
  body: unknown;
}): Promise<{
  embedding?: { values?: number[] };
  embeddings?: Array<{ values?: number[] }>;
}> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-goog-api-key": params.client.apiKey,
    ...params.client.headers,
  };

  return await withRemoteHttpResponse({
    url: params.endpoint,
    init: {
      method: "POST",
      headers,
      body: JSON.stringify(params.body),
    },
    onResponse: async (res) => {
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`gemini embeddings failed: ${res.status} ${text}`);
      }
      return (await res.json()) as {
        embedding?: { values?: number[] };
        embeddings?: Array<{ values?: number[] }>;
      };
    },
  });
}

function normalizeGeminiBaseUrl(raw: string): string {
  const trimmed = raw.replace(/\/+$/, "");
  const openAiIndex = trimmed.indexOf("/openai");
  if (openAiIndex > -1) {
    return trimmed.slice(0, openAiIndex);
  }
  return trimmed;
}

function buildGeminiModelPath(model: string): string {
  return model.startsWith("models/") ? model : `models/${model}`;
}

export async function createGeminiEmbeddingProvider(
  options: EmbeddingProviderOptions,
): Promise<{ provider: EmbeddingProvider; client: GeminiEmbeddingClient }> {
  const client = resolveGeminiEmbeddingClient(options);
  const baseUrl = client.baseUrl.replace(/\/$/, "");
  const embedUrl = `${baseUrl}/${client.modelPath}:embedContent`;
  const batchUrl = `${baseUrl}/${client.modelPath}:batchEmbedContents`;
  const isV2 = isGeminiEmbedding2Model(client.model);
  const outputDimensionality = client.outputDimensionality;

  const embedQuery = async (text: string): Promise<number[]> => {
    if (!text.trim()) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: embedUrl,
      body: buildGeminiTextEmbeddingRequest({
        text,
        taskType: options.taskType ?? "RETRIEVAL_QUERY",
        outputDimensionality: isV2 ? outputDimensionality : undefined,
      }),
    });
    return sanitizeAndNormalizeEmbedding(payload.embedding?.values ?? []);
  };

  const embedBatch = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }
    const payload = await fetchGeminiEmbeddingPayload({
      client,
      endpoint: batchUrl,
      body: {
        requests: texts.map((text) =>
          buildGeminiTextEmbeddingRequest({
            text,
            modelPath: client.modelPath,
            taskType: options.taskType ?? "RETRIEVAL_DOCUMENT",
            outputDimensionality: isV2 ? outputDimensionality : undefined,
          }),
        ),
      },
    });
    const embeddings = Array.isArray(payload.embeddings) ? payload.embeddings : [];
    return texts.map((_, index) => sanitizeAndNormalizeEmbedding(embeddings[index]?.values ?? []));
  };

  return {
    provider: {
      id: "gemini",
      model: client.model,
      maxInputTokens: GEMINI_MAX_INPUT_TOKENS[client.model],
      embedQuery,
      embedBatch,
    },
    client,
  };
}

export function resolveGeminiEmbeddingClient(
  options: EmbeddingProviderOptions,
): GeminiEmbeddingClient {
  const remote = options.remote;

  // Resolve API key: config remote.apiKey -> env GEMINI_API_KEY -> env GOOGLE_API_KEY
  let apiKey = remote?.apiKey?.trim();

  // Support env var indirection: if the value is an env var name, resolve it
  if (apiKey === "GEMINI_API_KEY" || apiKey === "GOOGLE_API_KEY") {
    apiKey = process.env[apiKey]?.trim();
  }

  if (!apiKey) {
    apiKey = process.env.GEMINI_API_KEY?.trim() || process.env.GOOGLE_API_KEY?.trim();
  }

  if (!apiKey) {
    throw new Error(
      `No API key found for embedding provider "gemini". ` +
        `Set remote.apiKey in config or the GEMINI_API_KEY environment variable.`,
    );
  }

  const rawBaseUrl = remote?.baseUrl?.trim() || DEFAULT_GEMINI_BASE_URL;
  const baseUrl = normalizeGeminiBaseUrl(rawBaseUrl);
  const headers: Record<string, string> = {
    ...remote?.headers,
  };
  const model = normalizeGeminiModel(options.model);
  const modelPath = buildGeminiModelPath(model);
  const outputDimensionality = resolveGeminiOutputDimensionality(
    model,
    options.outputDimensionality,
  );

  return { baseUrl, headers, model, modelPath, apiKey, outputDimensionality };
}
