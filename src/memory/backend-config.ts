/**
 * Resolves a full memory backend configuration from OpenClaude's MemoryConfig.
 *
 * Simplified from OpenClaw's version: only the "builtin" backend is supported
 * (no QMD). This is mostly a validation passthrough since OpenClaude's config
 * already contains all necessary fields.
 */
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

/**
 * Resolve and validate a MemoryConfig into the shape consumed by
 * MemoryIndexManager.get(). Since OpenClaude only supports the builtin
 * backend, this is largely a passthrough with minor normalization.
 */
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
