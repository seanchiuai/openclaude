export function buildRemoteBaseUrlPolicy(_baseUrl: string): undefined {
  return undefined;
}

export async function withRemoteHttpResponse<T>(params: {
  url: string;
  init?: RequestInit;
  ssrfPolicy?: unknown;
  auditContext?: string;
  onResponse: (response: Response) => Promise<T>;
}): Promise<T> {
  const response = await fetch(params.url, params.init);
  return await params.onResponse(response);
}
