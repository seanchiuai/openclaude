/**
 * Search manager factory — creates and caches MemoryIndexManager instances.
 *
 * Simplified from OpenClaw's version: no QMD fallback, no FallbackMemoryManager.
 * Just creates builtin MemoryIndexManager instances via the existing .get() API.
 */
import { createLogger } from "../logging/logger.js";
import type { MemoryConfig } from "../config/types.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import type { MemorySearchManager } from "./types.js";

const log = createLogger("memory");

let managerModulePromise: Promise<
  typeof import("./manager.js")
> | null = null;

function loadManagerModule() {
  managerModulePromise ??= import("./manager.js");
  return managerModulePromise;
}

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

/**
 * Get or create a MemorySearchManager for the given config.
 * Returns { manager, error? } — manager is null when memory is disabled
 * or initialization fails.
 */
export async function getMemorySearchManager(
  config: MemoryConfig,
  opts?: { purpose?: "default" | "status" },
): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(config);

  if (!resolved.enabled) {
    return { manager: null };
  }

  try {
    const { MemoryIndexManager } = await loadManagerModule();
    const manager = await MemoryIndexManager.get({
      memoryConfig: config,
      purpose: opts?.purpose,
    });
    return { manager };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`memory manager initialization failed: ${message}`);
    return { manager: null, error: message };
  }
}

/**
 * Close and clean up all cached MemoryIndexManager instances.
 */
export async function closeAllMemorySearchManagers(): Promise<void> {
  if (managerModulePromise !== null) {
    const { closeAllMemoryIndexManagers } = await loadManagerModule();
    await closeAllMemoryIndexManagers();
  }
}
