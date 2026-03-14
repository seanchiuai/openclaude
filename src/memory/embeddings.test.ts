import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider, type EmbeddingProviderResult } from "./embeddings.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireProvider(result: EmbeddingProviderResult) {
  if (!result.provider) {
    throw new Error("Expected embedding provider but got null");
  }
  return result.provider;
}

const createFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ data: [{ embedding: [1, 2, 3] }] }),
    text: async () => "",
  }));

const createGeminiFetchMock = () =>
  vi.fn(async (_input?: unknown, _init?: unknown) => ({
    ok: true,
    status: 200,
    json: async () => ({ embedding: { values: [1, 2, 3] } }),
    text: async () => "",
  }));

// ---------------------------------------------------------------------------
// Factory: createEmbeddingProvider
// ---------------------------------------------------------------------------

describe("createEmbeddingProvider", () => {
  it("returns null provider when auto mode finds no API keys", async () => {
    // No env vars set — all providers should fail with missing key errors
    const result = await createEmbeddingProvider({
      provider: "auto",
      model: "",
    });

    expect(result.provider).toBeNull();
    expect(result.requestedProvider).toBe("auto");
    expect(result.providerUnavailableReason).toBeDefined();
    expect(result.providerUnavailableReason).toContain("No API key");
  });

  it("returns null provider when explicit provider has no API key", async () => {
    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
    });

    expect(result.provider).toBeNull();
    expect(result.requestedProvider).toBe("openai");
    expect(result.providerUnavailableReason).toBeDefined();
  });

  it("returns null when both primary and fallback fail with missing keys", async () => {
    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "gemini",
    });

    expect(result.provider).toBeNull();
    expect(result.requestedProvider).toBe("openai");
    expect(result.fallbackFrom).toBe("openai");
    expect(result.providerUnavailableReason).toContain("Fallback to gemini failed");
  });

  it("falls back to secondary provider when primary has no key", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MISTRAL_API_KEY", "test-mistral-key");

    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      fallback: "mistral",
    });

    const provider = requireProvider(result);
    expect(provider.id).toBe("mistral");
    expect(result.fallbackFrom).toBe("openai");
    expect(result.fallbackReason).toContain("No API key");
  });
});

// ---------------------------------------------------------------------------
// Auto selection
// ---------------------------------------------------------------------------

describe("auto selection", () => {
  it("prefers openai when OPENAI_API_KEY is set", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OPENAI_API_KEY", "test-openai-key");

    const result = await createEmbeddingProvider({
      provider: "auto",
      model: "",
    });

    const provider = requireProvider(result);
    expect(provider.id).toBe("openai");
    expect(result.requestedProvider).toBe("auto");
  });

  it("falls through to gemini when openai key missing", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GEMINI_API_KEY", "test-gemini-key");

    const result = await createEmbeddingProvider({
      provider: "auto",
      model: "",
    });

    const provider = requireProvider(result);
    expect(provider.id).toBe("gemini");
  });

  it("uses mistral when openai/gemini/voyage are missing", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("MISTRAL_API_KEY", "test-mistral-key");

    const result = await createEmbeddingProvider({
      provider: "auto",
      model: "",
    });

    const provider = requireProvider(result);
    expect(provider.id).toBe("mistral");
  });
});

// ---------------------------------------------------------------------------
// OpenAI provider
// ---------------------------------------------------------------------------

describe("openai provider", () => {
  it("makes correct HTTP call with bearer auth", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      remote: { apiKey: "my-openai-key" },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer my-openai-key");
    const body = JSON.parse(init.body as string) as { model: string; input: string[] };
    expect(body.model).toBe("text-embedding-3-small");
    expect(body.input).toEqual(["hello"]);
  });

  it("uses custom baseUrl when provided", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      remote: {
        apiKey: "key",
        baseUrl: "https://custom.example.com/v1",
      },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("test");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://custom.example.com/v1/embeddings");
  });
});

// ---------------------------------------------------------------------------
// Gemini provider
// ---------------------------------------------------------------------------

describe("gemini provider", () => {
  it("makes correct HTTP call with x-goog-api-key header", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "gemini",
      model: "text-embedding-004",
      remote: { apiKey: "gemini-key" },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent",
    );
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("gemini-key");
  });

  it("resolves GEMINI_API_KEY env var indirection", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GEMINI_API_KEY", "env-gemini-key");

    const result = await createEmbeddingProvider({
      provider: "gemini",
      model: "text-embedding-004",
      remote: { apiKey: "GEMINI_API_KEY" },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("env-gemini-key");
  });

  it("falls back to GOOGLE_API_KEY env var", async () => {
    const fetchMock = createGeminiFetchMock();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GOOGLE_API_KEY", "google-key");

    const result = await createEmbeddingProvider({
      provider: "gemini",
      model: "text-embedding-004",
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-goog-api-key"]).toBe("google-key");
  });

  it("uses batch endpoint for embedBatch", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        embeddings: [{ values: [1, 2, 3] }, { values: [4, 5, 6] }],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "gemini",
      model: "text-embedding-004",
      remote: { apiKey: "key" },
    });

    const provider = requireProvider(result);
    const embeddings = await provider.embedBatch(["hello", "world"]);

    expect(embeddings).toHaveLength(2);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain(":batchEmbedContents");
  });
});

// ---------------------------------------------------------------------------
// Mistral provider
// ---------------------------------------------------------------------------

describe("mistral provider", () => {
  it("makes correct HTTP call with bearer auth", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "mistral",
      model: "mistral/mistral-embed",
      remote: { apiKey: "mistral-key" },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.mistral.ai/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mistral-key");
    const body = JSON.parse(init.body as string) as { model: string };
    expect(body.model).toBe("mistral-embed");
  });
});

// ---------------------------------------------------------------------------
// Voyage provider
// ---------------------------------------------------------------------------

describe("voyage provider", () => {
  it("makes correct HTTP call with bearer auth and input_type", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "voyage",
      model: "voyage-4-large",
      remote: { apiKey: "voyage-key" },
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.voyageai.com/v1/embeddings");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer voyage-key");
    const body = JSON.parse(init.body as string) as { input_type?: string };
    expect(body.input_type).toBe("query");
  });
});

// ---------------------------------------------------------------------------
// Ollama provider
// ---------------------------------------------------------------------------

describe("ollama provider", () => {
  it("makes correct HTTP call to local server", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: [1, 2, 3] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/api/embeddings");
    const body = JSON.parse(init.body as string) as { model: string; prompt: string };
    expect(body.model).toBe("nomic-embed-text");
    expect(body.prompt).toBe("hello");
  });

  it("uses OLLAMA_HOST env var for base URL", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: [1, 2, 3] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OLLAMA_HOST", "http://my-ollama:9999");

    const result = await createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://my-ollama:9999/api/embeddings");
  });

  it("adds bearer auth when OLLAMA_API_KEY is set", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ embedding: [1, 2, 3] }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("OLLAMA_API_KEY", "ollama-secret");

    const result = await createEmbeddingProvider({
      provider: "ollama",
      model: "nomic-embed-text",
    });

    const provider = requireProvider(result);
    await provider.embedQuery("hello");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer ollama-secret");
  });
});

// ---------------------------------------------------------------------------
// EmbeddingProvider interface contract
// ---------------------------------------------------------------------------

describe("EmbeddingProvider interface contract", () => {
  it("embedQuery returns number[]", async () => {
    const fetchMock = createFetchMock();
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      remote: { apiKey: "key" },
    });

    const provider = requireProvider(result);
    const vec = await provider.embedQuery("hello");
    expect(Array.isArray(vec)).toBe(true);
    expect(vec.every((v) => typeof v === "number")).toBe(true);
  });

  it("embedBatch returns number[][]", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }],
      }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await createEmbeddingProvider({
      provider: "openai",
      model: "text-embedding-3-small",
      remote: { apiKey: "key" },
    });

    const provider = requireProvider(result);
    const vecs = await provider.embedBatch(["a", "b"]);
    expect(Array.isArray(vecs)).toBe(true);
    expect(vecs).toHaveLength(2);
    for (const vec of vecs) {
      expect(Array.isArray(vec)).toBe(true);
    }
  });
});
