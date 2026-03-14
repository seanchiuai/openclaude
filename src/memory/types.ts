export type MemorySource = "memory" | "sessions";

export type MemorySearchResult = {
  path: string;
  startLine: number;
  endLine: number;
  score: number;
  snippet: string;
  source: MemorySource;
  citation?: string;
};

export type MemoryChunk = {
  startLine: number;
  endLine: number;
  text: string;
  hash: string;
  embeddingInput?: {
    text: string;
    parts?: Array<
      | { type: "text"; text: string }
      | { type: "inline-data"; mimeType: string; data: string }
    >;
  };
};

export type MemoryFileEntry = {
  path: string;
  absPath: string;
  mtimeMs: number;
  size: number;
  hash: string;
  dataHash?: string;
  kind?: "markdown" | "multimodal";
  contentText?: string;
  modality?: "image" | "audio";
  mimeType?: string;
};

export type MemorySyncProgress = {
  completed: number;
  total: number;
  label?: string;
};

export type MemoryProviderStatus = {
  provider: string;
  model?: string;
  files: number;
  chunks: number;
  dirty: boolean;
  dbPath: string;
  fts: { enabled: boolean; available: boolean; error?: string };
  vector: {
    enabled: boolean;
    available?: boolean;
    dims?: number;
    loadError?: string;
  };
  cache: { enabled: boolean; entries: number };
};
