/**
 * Tests that sync failures in watch-triggered syncs do not cause unhandled rejections.
 */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getEmbedBatchMock, resetEmbeddingMocks } from "./test-embeddings-mock.js";
import type { MemoryIndexManager } from "./index.js";
import { buildTestMemoryConfig, getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager sync failures", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;
  const embedBatch = getEmbedBatchMock();

  beforeEach(async () => {
    vi.useFakeTimers();
    resetEmbeddingMocks();
    embedBatch.mockImplementation(async () => {
      throw new Error("openai embeddings failed: 400 bad request");
    });
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaude-mem-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Hello");
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("does not raise unhandledRejection when watch-triggered sync fails", async () => {
    const unhandled: unknown[] = [];
    const handler = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", handler);

    const memoryConfig = buildTestMemoryConfig({
      workspaceDir,
      indexPath,
      watch: true,
      watchDebounceMs: 1,
    });

    manager = await getRequiredMemoryIndexManager({ memoryConfig, workspaceDir });
    const syncSpy = vi.spyOn(manager, "sync");

    // Call the internal scheduler directly; it uses fire-and-forget sync.
    (manager as unknown as { scheduleWatchSync: () => void }).scheduleWatchSync();

    await vi.runOnlyPendingTimersAsync();
    const syncPromise = syncSpy.mock.results[0]?.value as Promise<void> | undefined;
    vi.useRealTimers();
    if (syncPromise) {
      await syncPromise.catch(() => undefined);
    }

    process.off("unhandledRejection", handler);
    expect(unhandled).toHaveLength(0);
  });
});
