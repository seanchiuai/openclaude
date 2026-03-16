/**
 * Contract tests for gateway/lifecycle.ts
 *
 * Module under test: startGateway, readPidFile
 *
 * Dependencies (all mocked):
 * - config/loader.js        → loadConfig, ensureDirectories
 * - engine/pool.js          → createProcessPool
 * - router/index.js         → createRouter
 * - gateway/http.js         → createGatewayApp, startHttpServer
 * - channels/telegram/index.js → createTelegramChannel (dynamic import)
 * - node:fs                 → writeFileSync, unlinkSync, existsSync, readFileSync
 * - config/paths.js         → paths.pidFile
 *
 * Contracts verified:
 * 1. Boots with minimal config (no channels) — pool created, HTTP started
 * 2. Boots with telegram enabled — imports and starts telegram channel
 * 3. Writes PID file on start
 * 4. Removes PID file on shutdown
 * 5. Shutdown stops channels → drains pool → closes HTTP (order matters)
 * 6. readPidFile returns null when file doesn't exist
 * 7. readPidFile returns null for dead process
 * 8. readPidFile returns pid for alive process
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockPidFile = "/tmp/test-openclaude.pid";

vi.mock("../config/paths.js", () => ({
  paths: {
    pidFile: mockPidFile,
    base: "/tmp/test-openclaude",
    memoryDb: "/tmp/test-openclaude/memory/openclaude.sqlite",
    heartbeat: "/tmp/test-openclaude/HEARTBEAT.md",
    sessions: "/tmp/test-openclaude/sessions",
    skills: "/tmp/test-openclaude/skills",
  },
}));

const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock("node:fs", () => ({
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...args),
  unlinkSync: (...args: unknown[]) => mockUnlinkSync(...args),
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

const mockLoadConfig = vi.fn();
const mockEnsureDirectories = vi.fn();

vi.mock("../config/loader.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  ensureDirectories: () => mockEnsureDirectories(),
}));

const mockPool = {
  stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
  listSessions: vi.fn().mockReturnValue([]),
  submit: vi.fn(),
  drain: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn(),
  getSession: vi.fn(),
};
const mockCreateProcessPool = vi.fn().mockReturnValue(mockPool);

vi.mock("../engine/pool.js", () => ({
  createProcessPool: (...args: unknown[]) => mockCreateProcessPool(...args),
}));

const mockRouterFn = vi.fn().mockResolvedValue("mock response");
const mockCreateRouter = vi.fn().mockReturnValue(mockRouterFn);
vi.mock("../router/index.js", () => ({
  createRouter: (...args: unknown[]) => mockCreateRouter(...args),
}));

const mockApp = { fetch: vi.fn() };
const mockCreateGatewayApp = vi.fn().mockReturnValue(mockApp);
const mockServer = { close: vi.fn() };
const mockStartHttpServer = vi.fn().mockReturnValue(mockServer);

vi.mock("./http.js", () => ({
  createGatewayApp: (...args: unknown[]) => mockCreateGatewayApp(...args),
  startHttpServer: (...args: unknown[]) => mockStartHttpServer(...args),
}));

const mockTelegramChannel = {
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};
const mockCreateTelegramChannel = vi
  .fn()
  .mockReturnValue(mockTelegramChannel);

vi.mock("../channels/telegram/index.js", () => ({
  createTelegramChannel: (...args: unknown[]) =>
    mockCreateTelegramChannel(...args),
}));

const mockMemoryManager = {
  search: vi.fn(),
  sync: vi.fn().mockResolvedValue(undefined),
  readFile: vi.fn(),
  status: vi.fn().mockReturnValue({ provider: "fts-only", files: 0, chunks: 0, dirty: true, dbPath: "", fts: { enabled: true, available: true }, vector: { enabled: false }, cache: { enabled: false, entries: 0 } }),
  close: vi.fn(),
};
const mockCloseAllMemoryIndexManagers = vi.fn().mockResolvedValue(undefined);

vi.mock("../memory/index.js", () => ({
  MemoryIndexManager: {
    get: vi.fn().mockResolvedValue(mockMemoryManager),
  },
  closeAllMemoryIndexManagers: (...args: unknown[]) => mockCloseAllMemoryIndexManagers(...args),
}));

const mockLoadSkills = vi.fn().mockResolvedValue([]);

vi.mock("../skills/index.js", () => ({
  loadSkills: (...args: unknown[]) => mockLoadSkills(...args),
}));

const mockCronService = {
  start: vi.fn(),
  stop: vi.fn(),
};
const mockCreateCronService = vi.fn().mockReturnValue(mockCronService);

vi.mock("../cron/index.js", () => ({
  createCronService: (...args: unknown[]) => mockCreateCronService(...args),
}));

const mockHeartbeatRunner = {
  start: vi.fn(),
  stop: vi.fn(),
};
const mockCreateHeartbeatRunner = vi.fn().mockReturnValue(mockHeartbeatRunner);

vi.mock("../cron/heartbeat.js", () => ({
  createHeartbeatRunner: (...args: unknown[]) =>
    mockCreateHeartbeatRunner(...args),
}));

const mockAuthMiddleware = vi.fn(async (_c: unknown, next: () => Promise<void>) => { await next(); });
vi.mock("./auth.js", () => ({
  createAuthMiddleware: () => ({ middleware: mockAuthMiddleware }),
}));

vi.mock("../engine/session-cleanup.js", () => ({
  sweepStaleSessions: () => ({ removed: [], errors: [] }),
}));

const mockCleanStaleGatewayProcessesSync = vi.fn().mockReturnValue([]);
vi.mock("../engine/orphan-reaper.js", () => ({
  cleanStaleGatewayProcessesSync: (...args: unknown[]) => mockCleanStaleGatewayProcessesSync(...args),
}));

const mockKillProcessGroup = vi.fn();
vi.mock("../engine/spawn.js", () => ({
  killProcessGroup: (...args: unknown[]) => mockKillProcessGroup(...args),
}));

const mockCheckClaudeCliVersion = vi.fn(() => ({ raw: "1.0.20 (Claude Code)", version: "1.0.20" }));
vi.mock("../engine/cli-version.js", () => ({
  checkClaudeCliVersion: (...args: unknown[]) => mockCheckClaudeCliVersion(...args),
}));

// Minimal config with no channels enabled
function minimalConfig() {
  return {
    agent: { maxConcurrent: 4 },
    channels: {},
    heartbeat: { enabled: false, every: 1_800_000 },
    memory: { enabled: true, dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite" },
    cron: { enabled: false, storePath: "/tmp/test-cron/jobs.json" },
    gateway: { port: 45557, auth: { mode: "none" as const } },
  };
}

// Config with telegram enabled
function telegramConfig() {
  return {
    agent: { maxConcurrent: 4 },
    channels: {
      telegram: { enabled: true, token: "fake-token" },
    },
    heartbeat: { enabled: false, every: 1_800_000 },
    memory: { enabled: true, dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite" },
    cron: { enabled: false, storePath: "/tmp/test-cron/jobs.json" },
    gateway: { port: 45557, auth: { mode: "none" as const } },
  };
}

// Suppress console.error during tests
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Re-apply default mock implementations after restoreAllMocks
  mockCreateProcessPool.mockReturnValue(mockPool);
  mockPool.stats.mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 });
  mockPool.listSessions.mockReturnValue([]);
  mockPool.drain.mockResolvedValue(undefined);
  mockCreateGatewayApp.mockReturnValue(mockApp);
  mockStartHttpServer.mockReturnValue(mockServer);
  mockCreateTelegramChannel.mockReturnValue(mockTelegramChannel);
  mockTelegramChannel.start.mockResolvedValue(undefined);
  mockTelegramChannel.stop.mockResolvedValue(undefined);
  mockMemoryManager.sync.mockResolvedValue(undefined);
  mockCloseAllMemoryIndexManagers.mockResolvedValue(undefined);
  mockCreateRouter.mockReturnValue(mockRouterFn);
  mockCreateCronService.mockReturnValue(mockCronService);
  mockCreateHeartbeatRunner.mockReturnValue(mockHeartbeatRunner);
  mockCronService.start.mockReturnValue(undefined);
  mockCronService.stop.mockReturnValue(undefined);
  mockHeartbeatRunner.start.mockReturnValue(undefined);
  mockHeartbeatRunner.stop.mockReturnValue(undefined);
  mockLoadSkills.mockResolvedValue([]);
  mockCleanStaleGatewayProcessesSync.mockReturnValue([]);
  mockKillProcessGroup.mockReturnValue(undefined);
  mockCheckClaudeCliVersion.mockReturnValue({ raw: "1.0.20 (Claude Code)", version: "1.0.20" });
});

describe("startGateway", () => {
  it("boots with minimal config — pool created, HTTP started", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    expect(mockEnsureDirectories).toHaveBeenCalled();
    expect(mockCreateProcessPool).toHaveBeenCalledWith(4);
    expect(mockCreateGatewayApp).toHaveBeenCalledWith(
      expect.objectContaining({
        pool: mockPool,
        startedAt: expect.any(Number),
        channels: expect.any(Array),
      }),
    );
    expect(mockStartHttpServer).toHaveBeenCalledWith(mockApp, 45557);
    expect(gw.pool).toBe(mockPool);
    expect(gw.channels.size).toBe(0);
  });

  it("boots with telegram enabled — imports and starts telegram channel", async () => {
    mockLoadConfig.mockReturnValue(telegramConfig());

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    expect(mockCreateTelegramChannel).toHaveBeenCalledWith(
      { enabled: true, token: "fake-token" },
      expect.anything(), // router
    );
    expect(mockTelegramChannel.start).toHaveBeenCalled();
    expect(gw.channels.has("telegram")).toBe(true);
  });

  it("writes PID file on start", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("./lifecycle.js");
    await startGateway();

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      mockPidFile,
      String(process.pid),
      "utf-8",
    );
  });

  it("removes PID file on shutdown", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    await gw.shutdown();

    expect(mockUnlinkSync).toHaveBeenCalledWith(mockPidFile);
  });

  it("shutdown stops channels → drains pool → closes HTTP (in order)", async () => {
    mockLoadConfig.mockReturnValue(telegramConfig());

    const callOrder: string[] = [];
    mockCloseAllMemoryIndexManagers.mockImplementation(async () => {
      callOrder.push("memory.close");
    });
    mockTelegramChannel.stop.mockImplementation(async () => {
      callOrder.push("channel.stop");
    });
    mockPool.drain.mockImplementation(async () => {
      callOrder.push("pool.drain");
    });
    mockServer.close.mockImplementation(() => {
      callOrder.push("server.close");
    });

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    await gw.shutdown();

    expect(callOrder).toEqual(["memory.close", "channel.stop", "pool.drain", "server.close"]);
  });

  it("logs Claude CLI version at startup", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("./lifecycle.js");
    await startGateway();

    expect(mockCheckClaudeCliVersion).toHaveBeenCalled();
  });

  it("calls orphan reaper on startup", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());
    const { startGateway } = await import("./lifecycle.js");
    await startGateway();
    expect(mockCleanStaleGatewayProcessesSync).toHaveBeenCalledWith(45557);
  });

  it("falls back to default port when OPENCLAUDE_GATEWAY_PORT is non-numeric", async () => {
    const original = process.env.OPENCLAUDE_GATEWAY_PORT;
    process.env.OPENCLAUDE_GATEWAY_PORT = "not-a-number";

    try {
      mockLoadConfig.mockReturnValue(minimalConfig());
      const { startGateway } = await import("./lifecycle.js");
      await startGateway();

      // Should fall back to config default (45557), not NaN
      expect(mockStartHttpServer).toHaveBeenCalledWith(mockApp, 45557);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAUDE_GATEWAY_PORT;
      } else {
        process.env.OPENCLAUDE_GATEWAY_PORT = original;
      }
    }
  });

  it("falls back to default port when OPENCLAUDE_GATEWAY_PORT is out of range", async () => {
    const original = process.env.OPENCLAUDE_GATEWAY_PORT;
    process.env.OPENCLAUDE_GATEWAY_PORT = "99999";

    try {
      mockLoadConfig.mockReturnValue(minimalConfig());
      const { startGateway } = await import("./lifecycle.js");
      await startGateway();

      expect(mockStartHttpServer).toHaveBeenCalledWith(mockApp, 45557);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAUDE_GATEWAY_PORT;
      } else {
        process.env.OPENCLAUDE_GATEWAY_PORT = original;
      }
    }
  });

  it("uses OPENCLAUDE_GATEWAY_PORT when valid", async () => {
    const original = process.env.OPENCLAUDE_GATEWAY_PORT;
    process.env.OPENCLAUDE_GATEWAY_PORT = "8080";

    try {
      mockLoadConfig.mockReturnValue(minimalConfig());
      const { startGateway } = await import("./lifecycle.js");
      await startGateway();

      expect(mockStartHttpServer).toHaveBeenCalledWith(mockApp, 8080);
    } finally {
      if (original === undefined) {
        delete process.env.OPENCLAUDE_GATEWAY_PORT;
      } else {
        process.env.OPENCLAUDE_GATEWAY_PORT = original;
      }
    }
  });

  it("memory sync failure during boot doesn't crash gateway", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());
    mockMemoryManager.sync.mockRejectedValue(new Error("sync failed"));

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    expect(gw.pool).toBe(mockPool);
  });
});

describe("shutdown", () => {
  it("shutdown continues when channel.stop() throws", async () => {
    mockLoadConfig.mockReturnValue(telegramConfig());
    mockTelegramChannel.stop.mockRejectedValue(new Error("stop failed"));

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    await expect(gw.shutdown()).resolves.toBeUndefined();

    expect(mockPool.drain).toHaveBeenCalled();
    expect(mockServer.close).toHaveBeenCalled();
  });

  it("shutdown with cron and heartbeat enabled stops them", async () => {
    const config = {
      agent: { maxConcurrent: 4 },
      channels: {},
      heartbeat: { enabled: true, every: 1_800_000, checklistPath: "/tmp/test-openclaude/HEARTBEAT.md" },
      memory: { enabled: true, dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite" },
      cron: { enabled: true, storePath: "/tmp/test-cron/jobs.json" },
      gateway: { port: 45557, auth: { mode: "none" as const } },
    };
    mockLoadConfig.mockReturnValue(config);

    const { startGateway } = await import("./lifecycle.js");
    const gw = await startGateway();

    await gw.shutdown();

    expect(mockCronService.stop).toHaveBeenCalled();
    expect(mockHeartbeatRunner.stop).toHaveBeenCalled();
  });
});

describe("readPidFile", () => {
  it("returns null when file doesn't exist", async () => {
    mockExistsSync.mockReturnValue(false);

    const { readPidFile } = await import("./lifecycle.js");
    expect(readPidFile()).toBeNull();
  });

  it("returns null for dead process (process.kill throws)", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("99999999");
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw new Error("ESRCH");
    });

    const { readPidFile } = await import("./lifecycle.js");
    expect(readPidFile()).toBeNull();
    // Should also clean up the stale PID file
    expect(mockUnlinkSync).toHaveBeenCalledWith(mockPidFile);
  });

  it("returns null for non-numeric PID content", async () => {
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue("not-a-number");

    const { readPidFile } = await import("./lifecycle.js");
    expect(readPidFile()).toBeNull();
  });

  it("returns pid for alive process", async () => {
    const alivePid = process.pid; // current process is definitely alive
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(String(alivePid));
    vi.spyOn(process, "kill").mockImplementation(() => true);

    const { readPidFile } = await import("./lifecycle.js");
    expect(readPidFile()).toBe(alivePid);
  });
});
