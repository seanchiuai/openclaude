import {
  resolveRemoteEmbeddingBearerClient,
  type RemoteEmbeddingProviderId,
} from "./embeddings-remote-client.js";
import { fetchRemoteEmbeddingVectors } from "./embeddings-remote-fetch.js";

export type RemoteEmbeddingClient = {
  baseUrl: string;
  headers: Record<string, string>;
  ssrfPolicy?: unknown;
  model: string;
};

export function createRemoteEmbeddingProvider(params: {
  id: string;
  client: RemoteEmbeddingClient;
  errorPrefix: string;
  maxInputTokens?: number;
}): {
  id: string;
  model: string;
  maxInputTokens?: number;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
} {
  const { client } = params;
  const url = `${client.baseUrl.replace(/\/$/, "")}/embeddings`;

  const embed = async (input: string[]): Promise<number[][]> => {
    if (input.length === 0) {
      return [];
    }
    return await fetchRemoteEmbeddingVectors({
      url,
      headers: client.headers,
      ssrfPolicy: client.ssrfPolicy,
      body: { model: client.model, input },
      errorPrefix: params.errorPrefix,
    });
  };

  return {
    id: params.id,
    model: client.model,
    ...(typeof params.maxInputTokens === "number" ? { maxInputTokens: params.maxInputTokens } : {}),
    embedQuery: async (text) => {
      const [vec] = await embed([text]);
      return vec ?? [];
    },
    embedBatch: embed,
  };
}

export async function resolveRemoteEmbeddingClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: {
    remote?: {
      apiKey?: string;
      baseUrl?: string;
      headers?: Record<string, string>;
    };
    model: string;
  };
  defaultBaseUrl: string;
  normalizeModel: (model: string) => string;
}): Promise<RemoteEmbeddingClient> {
  const { baseUrl, headers } = await resolveRemoteEmbeddingBearerClient({
    provider: params.provider,
    options: params.options,
    defaultBaseUrl: params.defaultBaseUrl,
  });
  const model = params.normalizeModel(params.options.model);
  return { baseUrl, headers, model };
}
