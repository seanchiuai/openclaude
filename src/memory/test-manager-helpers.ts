/**
 * Shared test helpers for creating MemoryIndexManager instances in tests.
 * Ported from OpenClaw's test-manager-helpers.ts, adapted for OpenClaude's MemoryConfig.
 */
import path from "node:path";
import type { MemoryConfig } from "../config/types.js";
import { MemoryIndexManager } from "./manager.js";

/**
 * Build a MemoryConfig suitable for testing.
 * Overrides allow customizing workspace, index path, watch, vector settings, etc.
 */
export function buildTestMemoryConfig(overrides: {
  workspaceDir: string;
  indexPath?: string;
  watch?: boolean;
  watchDebounceMs?: number;
  vectorEnabled?: boolean;
  cacheEnabled?: boolean;
  hybridEnabled?: boolean;
  extraPaths?: string[];
}): MemoryConfig {
  const indexPath = overrides.indexPath ?? path.join(overrides.workspaceDir, "index.sqlite");
  return {
    enabled: true,
    dbPath: indexPath,
    sources: ["memory"],
    extraPaths: overrides.extraPaths ?? [],
    provider: "openai",
    model: "mock-embed",
    fallback: "none",
    remote: {
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    },
    store: {
      driver: "sqlite",
      path: indexPath,
      vector: { enabled: overrides.vectorEnabled ?? false },
    },
    chunking: { tokens: 512, overlap: 50 },
    sync: {
      onSessionStart: false,
      onSearch: false,
      watch: overrides.watch ?? false,
      watchDebounceMs: overrides.watchDebounceMs ?? 100,
      intervalMinutes: 0,
    },
    query: {
      maxResults: 10,
      minScore: 0,
      hybrid: {
        enabled: overrides.hybridEnabled ?? false,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 3,
        mmr: { enabled: false, lambda: 0.5 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
      },
    },
    cache: { enabled: overrides.cacheEnabled ?? false },
    multimodal: { enabled: false },
  };
}

/**
 * Create a MemoryIndexManager for testing, asserting that it is non-null.
 */
export async function getRequiredMemoryIndexManager(params: {
  memoryConfig: MemoryConfig;
  workspaceDir: string;
}): Promise<MemoryIndexManager> {
  const manager = await MemoryIndexManager.get({
    memoryConfig: params.memoryConfig,
    workspaceDir: params.workspaceDir,
  });
  if (!manager) {
    throw new Error("MemoryIndexManager.get() returned null — check memoryConfig.enabled");
  }
  return manager;
}
