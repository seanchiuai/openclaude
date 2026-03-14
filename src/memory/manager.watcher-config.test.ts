import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MemoryConfig } from "../config/types.js";
import { MemoryIndexManager } from "./manager.js";

const { watchMock } = vi.hoisted(() => ({
  watchMock: vi.fn(() => ({
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  })),
}));

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
  watch: watchMock,
}));

vi.mock("./sqlite-vec.js", () => ({
  loadSqliteVecExtension: async () => ({ ok: false, error: "sqlite-vec disabled in tests" }),
}));

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: async () => ({
    requestedProvider: "openai",
    provider: {
      id: "mock",
      model: "mock-embed",
      embedQuery: async () => [1, 0],
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    },
  }),
}));

function buildMemoryConfig(overrides: {
  workspaceDir: string;
  watch: boolean;
  watchDebounceMs: number;
  extraPaths?: string[];
}): MemoryConfig {
  return {
    enabled: true,
    dbPath: path.join(overrides.workspaceDir, "index.sqlite"),
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
      path: path.join(overrides.workspaceDir, "index.sqlite"),
      vector: { enabled: false },
    },
    chunking: { tokens: 512, overlap: 50 },
    sync: {
      onSessionStart: false,
      onSearch: false,
      watch: overrides.watch,
      watchDebounceMs: overrides.watchDebounceMs,
      intervalMinutes: 0,
    },
    query: {
      maxResults: 10,
      minScore: 0,
      hybrid: {
        enabled: false,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 3,
        mmr: { enabled: false, lambda: 0.5 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
      },
    },
    cache: { enabled: false },
    multimodal: { enabled: false },
  };
}

describe("memory watcher config", () => {
  let manager: MemoryIndexManager | null = null;
  let workspaceDir = "";
  let extraDir = "";

  afterEach(async () => {
    watchMock.mockClear();
    if (manager) {
      await manager.close();
      manager = null;
    }
    if (workspaceDir) {
      await fs.rm(workspaceDir, { recursive: true, force: true });
      workspaceDir = "";
      extraDir = "";
    }
  });

  it("watches markdown globs and ignores dependency directories", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaude-memory-watch-"));
    extraDir = path.join(workspaceDir, "extra");
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.md"), "hello");

    const memoryConfig = buildMemoryConfig({
      workspaceDir,
      watch: true,
      watchDebounceMs: 25,
      extraPaths: [extraDir],
    });

    manager = await MemoryIndexManager.get({ memoryConfig, workspaceDir });
    expect(manager).not.toBeNull();

    expect(watchMock).toHaveBeenCalledTimes(1);
    const [watchedPaths, options] = watchMock.mock.calls[0] as unknown as [
      string[],
      Record<string, unknown>,
    ];
    expect(watchedPaths).toEqual(
      expect.arrayContaining([
        path.join(workspaceDir, "MEMORY.md"),
        path.join(workspaceDir, "memory.md"),
        path.join(workspaceDir, "memory", "**", "*.md"),
        path.join(extraDir, "**", "*.md"),
      ]),
    );
    expect(options.ignoreInitial).toBe(true);
    expect(options.awaitWriteFinish).toEqual({ stabilityThreshold: 25, pollInterval: 100 });

    const ignored = options.ignored as ((watchPath: string) => boolean) | undefined;
    expect(ignored).toBeTypeOf("function");
    expect(ignored?.(path.join(workspaceDir, "memory", "node_modules", "pkg", "index.md"))).toBe(
      true,
    );
    expect(ignored?.(path.join(workspaceDir, "memory", ".venv", "lib", "python.md"))).toBe(true);
    expect(ignored?.(path.join(workspaceDir, "memory", "project", "notes.md"))).toBe(false);
  });

  it("does not start watcher when sync.watch is false", async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaude-memory-watch-"));
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });

    const memoryConfig = buildMemoryConfig({
      workspaceDir,
      watch: false,
      watchDebounceMs: 25,
    });

    manager = await MemoryIndexManager.get({ memoryConfig, workspaceDir });
    expect(manager).not.toBeNull();

    expect(watchMock).not.toHaveBeenCalled();
  });
});
