import { createLogger } from "../logging/logger.js";
import type { MemoryConfig } from "../config/types.js";
import { resolveMemoryBackendConfig } from "./backend-config.js";
import { MemoryIndexManager, closeAllMemoryIndexManagers } from "./manager.js";
import type { MemorySearchManager } from "./types.js";

const log = createLogger("memory");

export type MemorySearchManagerResult = {
  manager: MemorySearchManager | null;
  error?: string;
};

export async function getMemorySearchManager(
  config: MemoryConfig,
  opts?: { purpose?: "default" | "status" },
): Promise<MemorySearchManagerResult> {
  const resolved = resolveMemoryBackendConfig(config);

  if (!resolved.enabled) {
    return { manager: null };
  }

  try {
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

export async function closeAllMemorySearchManagers(): Promise<void> {
  await closeAllMemoryIndexManagers();
}
