/**
 * API key resolution and bearer client for remote embedding providers.
 * Adapted from OpenClaw — simplified to resolve keys from config or env vars
 * instead of model-auth.js / secret-input.js.
 */

export type RemoteEmbeddingProviderId = "openai" | "voyage" | "mistral";

const PROVIDER_ENV_VARS: Record<RemoteEmbeddingProviderId, string> = {
  openai: "OPENAI_API_KEY",
  voyage: "VOYAGE_API_KEY",
  mistral: "MISTRAL_API_KEY",
};

export async function resolveRemoteEmbeddingBearerClient(params: {
  provider: RemoteEmbeddingProviderId;
  options: {
    remote?: {
      apiKey?: string;
      baseUrl?: string;
      headers?: Record<string, string>;
    };
  };
  defaultBaseUrl: string;
}): Promise<{ baseUrl: string; headers: Record<string, string> }> {
  const remote = params.options.remote;

  // Resolve API key: (1) config remote.apiKey, (2) environment variable
  const apiKey =
    remote?.apiKey?.trim() || process.env[PROVIDER_ENV_VARS[params.provider]];

  if (!apiKey) {
    const envVar = PROVIDER_ENV_VARS[params.provider];
    throw new Error(
      `No API key found for embedding provider "${params.provider}". ` +
        `Set remote.apiKey in config or the ${envVar} environment variable.`,
    );
  }

  const baseUrl = remote?.baseUrl?.trim() || params.defaultBaseUrl;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    ...remote?.headers,
  };

  return { baseUrl, headers };
}
