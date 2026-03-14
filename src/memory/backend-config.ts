import type { MemoryConfig } from "../config/types.js";

export type ResolvedMemoryBackendConfig = {
  backend: "builtin";
  enabled: boolean;
  provider: MemoryConfig["provider"];
  model?: string;
  outputDimensionality?: number;
  fallback: MemoryConfig["fallback"];
  remote: MemoryConfig["remote"];
  store: MemoryConfig["store"];
  chunking: MemoryConfig["chunking"];
  sync: MemoryConfig["sync"];
  query: MemoryConfig["query"];
  cache: MemoryConfig["cache"];
  multimodal: MemoryConfig["multimodal"];
  dbPath: string;
  sources: MemoryConfig["sources"];
  extraPaths: MemoryConfig["extraPaths"];
};

export function resolveMemoryBackendConfig(
  config: MemoryConfig,
): ResolvedMemoryBackendConfig {
  return {
    backend: "builtin",
    enabled: config.enabled,
    provider: config.provider,
    model: config.model,
    outputDimensionality: config.outputDimensionality,
    fallback: config.fallback,
    remote: config.remote,
    store: config.store,
    chunking: config.chunking,
    sync: config.sync,
    query: config.query,
    cache: config.cache,
    multimodal: config.multimodal,
    dbPath: config.dbPath,
    sources: config.sources,
    extraPaths: config.extraPaths,
  };
}
