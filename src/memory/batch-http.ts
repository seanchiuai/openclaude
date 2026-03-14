import { postJson } from "./post-json.js";

async function retryAsync<T>(
  fn: () => Promise<T>,
  options: {
    attempts: number;
    minDelayMs: number;
    maxDelayMs: number;
    jitter: number;
    shouldRetry: (err: unknown) => boolean;
  },
): Promise<T> {
  for (let i = 0; i < options.attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i === options.attempts - 1 || !options.shouldRetry(e)) {
        throw e;
      }
      const baseDelay = Math.min(
        options.minDelayMs * Math.pow(2, i),
        options.maxDelayMs,
      );
      const jitterAmount = baseDelay * options.jitter * (Math.random() * 2 - 1);
      await new Promise((r) => setTimeout(r, baseDelay + jitterAmount));
    }
  }
  return fn();
}

export async function postJsonWithRetry<T>(params: {
  url: string;
  headers: Record<string, string>;
  ssrfPolicy?: unknown;
  body: unknown;
  errorPrefix: string;
}): Promise<T> {
  return await retryAsync(
    async () => {
      return await postJson<T>({
        url: params.url,
        headers: params.headers,
        ssrfPolicy: params.ssrfPolicy,
        body: params.body,
        errorPrefix: params.errorPrefix,
        attachStatus: true,
        parse: async (payload) => payload as T,
      });
    },
    {
      attempts: 3,
      minDelayMs: 300,
      maxDelayMs: 2000,
      jitter: 0.2,
      shouldRetry: (err) => {
        const status = (err as { status?: number }).status;
        return status === 429 || (typeof status === "number" && status >= 500);
      },
    },
  );
}
