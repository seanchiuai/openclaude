/**
 * Contract tests for integration boot sequence.
 *
 * Tests the full boot/shutdown lifecycle of startGateway with all
 * subsystems mocked. Uses the real startGateway function from
 * gateway/lifecycle.ts but with every dependency replaced by mocks.
 *
 * Dependencies (all mocked):
 * - config/loader.js         → loadConfig, ensureDirectories
 * - config/paths.js          → paths
 * - engine/pool.js           → createProcessPool
 * - router/index.js          → createRouter
 * - gateway/http.js          → createGatewayApp, startHttpServer
 * - channels/telegram/index.js → createTelegramChannel
 * - memory/index.js          → createMemoryManager
 * - cron/index.js             → createCronService
 * - cron/heartbeat.js         → createHeartbeatRunner
 * - node:fs                  → writeFileSync, unlinkSync, existsSync, readFileSync
 *
 * Contracts verified:
 * 1. Full boot: config loaded → pool created → channels started → HTTP started → ready
 * 2. Shutdown reverse order: channels stopped → pool drained → HTTP closed
 * 3. Missing config file → returns defaults, gateway still boots
 * 4. Invalid config → throws Zod error with path info
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Mocks ---

const mockPidFile = "/tmp/test-boot-openclaude.pid";

vi.mock("../config/paths.js", () => ({
  paths: {
    pidFile: mockPidFile,
    base: "/tmp/test-openclaude",
    logs: "/tmp/test-openclaude/logs",
    sessions: "/tmp/test-openclaude/sessions",
    memory: "/tmp/test-openclaude/memory",
    memoryDb: "/tmp/test-openclaude/memory/openclaude.sqlite",
    cron: "/tmp/test-openclaude/cron",
    skills: "/tmp/test-openclaude/skills",
    workspace: "/tmp/test-openclaude/workspace",
    config: "/tmp/test-openclaude/config.json",
    logFile: "/tmp/test-openclaude/logs/gateway.log",
    errLogFile: "/tmp/test-openclaude/logs/gateway.err.log",
    heartbeat: "/tmp/test-openclaude/HEARTBEAT.md",
  },
}));

const mockWriteFileSync = vi.fn();
const mockUnlinkSync = vi.fn();
const mockExistsSync = vi.fn().mockReturnValue(false);
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

vi.mock("../gateway/http.js", () => ({
  createGatewayApp: (...args: unknown[]) => mockCreateGatewayApp(...args),
  startHttpServer: (...args: unknown[]) => mockStartHttpServer(...args),
}));

const mockTelegramChannel = {
  id: "telegram",
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  sendText: vi.fn(),
};
const mockCreateTelegramChannel = vi.fn().mockReturnValue(mockTelegramChannel);

vi.mock("../channels/telegram/index.js", () => ({
  createTelegramChannel: (...args: unknown[]) =>
    mockCreateTelegramChannel(...args),
}));

const mockMemoryManager = {
  sync: vi.fn().mockResolvedValue(undefined),
  close: vi.fn(),
  status: vi.fn().mockReturnValue({
    provider: "none",
    files: 0,
    chunks: 0,
    fts: { available: false },
    dirty: false,
    dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite",
  }),
  search: vi.fn().mockResolvedValue([]),
};
const mockCreateMemoryManager = vi.fn().mockReturnValue(mockMemoryManager);

vi.mock("../memory/index.js", () => ({
  createMemoryManager: (...args: unknown[]) =>
    mockCreateMemoryManager(...args),
}));

const mockCronService = {
  start: vi.fn(),
  stop: vi.fn(),
  list: vi.fn().mockReturnValue([]),
  remove: vi.fn(),
  run: vi.fn(),
};
const mockCreateCronService = vi.fn().mockReturnValue(mockCronService);

vi.mock("../cron/index.js", () => ({
  createCronService: (...args: unknown[]) =>
    mockCreateCronService(...args),
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
vi.mock("../gateway/auth.js", () => ({
  createAuthMiddleware: () => ({ middleware: mockAuthMiddleware }),
}));

vi.mock("../engine/session-cleanup.js", () => ({
  sweepStaleSessions: () => ({ removed: [], errors: [] }),
}));

function minimalConfig() {
  return {
    agent: { maxConcurrent: 4, defaultTimeout: 300_000 },
    channels: {},
    heartbeat: { enabled: false, every: 1_800_000 },
    mcp: {},
    memory: { dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite" },
    cron: { enabled: false, storePath: "/tmp/test-openclaude/cron/jobs.json" },
    gateway: { port: 45557, auth: { mode: "none" as const } },
  };
}

function telegramConfig() {
  return {
    agent: { maxConcurrent: 2, defaultTimeout: 300_000 },
    channels: {
      telegram: { enabled: true, botToken: "fake-token" },
    },
    heartbeat: { enabled: false, every: 1_800_000 },
    mcp: {},
    memory: { dbPath: "/tmp/test-openclaude/memory/openclaude.sqlite" },
    cron: { enabled: false, storePath: "/tmp/test-openclaude/cron/jobs.json" },
    gateway: { port: 45557, auth: { mode: "none" as const } },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});

  // Re-apply defaults after restoreAllMocks
  mockCreateProcessPool.mockReturnValue(mockPool);
  mockPool.stats.mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 });
  mockPool.listSessions.mockReturnValue([]);
  mockPool.drain.mockResolvedValue(undefined);
  mockCreateGatewayApp.mockReturnValue(mockApp);
  mockStartHttpServer.mockReturnValue(mockServer);
  mockCreateTelegramChannel.mockReturnValue(mockTelegramChannel);
  mockTelegramChannel.start.mockResolvedValue(undefined);
  mockTelegramChannel.stop.mockResolvedValue(undefined);
  mockExistsSync.mockReturnValue(false);
  mockCreateMemoryManager.mockReturnValue(mockMemoryManager);
  mockMemoryManager.sync.mockResolvedValue(undefined);
  mockMemoryManager.close.mockReturnValue(undefined);
  mockCreateCronService.mockReturnValue(mockCronService);
  mockCreateHeartbeatRunner.mockReturnValue(mockHeartbeatRunner);
  mockCreateRouter.mockReturnValue(mockRouterFn);
});

describe("full boot sequence", () => {
  it("config loaded → pool created → HTTP started → ready", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("../gateway/lifecycle.js");
    const gw = await startGateway();

    // 1. Config loaded
    expect(mockEnsureDirectories).toHaveBeenCalled();
    expect(mockLoadConfig).toHaveBeenCalled();

    // 2. Pool created with config value
    expect(mockCreateProcessPool).toHaveBeenCalledWith(4);

    // 3. Router created with pool
    expect(mockCreateRouter).toHaveBeenCalled();

    // 4. HTTP server started
    expect(mockCreateGatewayApp).toHaveBeenCalled();
    expect(mockStartHttpServer).toHaveBeenCalledWith(mockApp, 45557);

    // 5. Gateway object is ready
    expect(gw.pool).toBe(mockPool);
    expect(gw.config).toEqual(minimalConfig());
    expect(typeof gw.shutdown).toBe("function");
  });

  it("with telegram: config loaded → pool → telegram started → HTTP started", async () => {
    mockLoadConfig.mockReturnValue(telegramConfig());

    const { startGateway } = await import("../gateway/lifecycle.js");
    const gw = await startGateway();

    // Telegram channel created and started
    expect(mockCreateTelegramChannel).toHaveBeenCalledWith(
      { enabled: true, botToken: "fake-token" },
      expect.anything(),
    );
    expect(mockTelegramChannel.start).toHaveBeenCalled();
    expect(gw.channels.has("telegram")).toBe(true);
  });

  it("writes PID file after successful boot", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("../gateway/lifecycle.js");
    await startGateway();

    expect(mockWriteFileSync).toHaveBeenCalledWith(
      mockPidFile,
      String(process.pid),
      "utf-8",
    );
  });
});

describe("shutdown sequence", () => {
  it("channels stopped → pool drained → HTTP closed (correct order)", async () => {
    mockLoadConfig.mockReturnValue(telegramConfig());

    const callOrder: string[] = [];
    mockMemoryManager.close.mockImplementation(() => {
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

    const { startGateway } = await import("../gateway/lifecycle.js");
    const gw = await startGateway();

    await gw.shutdown();

    expect(callOrder).toEqual(["memory.close", "channel.stop", "pool.drain", "server.close"]);
  });

  it("removes PID file after shutdown", async () => {
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("../gateway/lifecycle.js");
    const gw = await startGateway();

    await gw.shutdown();

    expect(mockUnlinkSync).toHaveBeenCalledWith(mockPidFile);
  });
});

describe("config edge cases", () => {
  it("missing config file → loadConfig returns defaults, gateway still boots", async () => {
    // loadConfig returns defaults when file doesn't exist
    mockLoadConfig.mockReturnValue(minimalConfig());

    const { startGateway } = await import("../gateway/lifecycle.js");
    const gw = await startGateway();

    expect(mockLoadConfig).toHaveBeenCalled();
    expect(gw.pool).toBe(mockPool);
    expect(gw.channels.size).toBe(0);
  });

  it("invalid config → throws Zod error with path info", async () => {
    // Simulate loadConfig throwing a Zod validation error
    const zodError = new Error(
      'Validation error: Required at "agent.maxConcurrent"',
    );
    zodError.name = "ZodError";
    mockLoadConfig.mockImplementation(() => {
      throw zodError;
    });

    const { startGateway } = await import("../gateway/lifecycle.js");

    await expect(startGateway()).rejects.toThrow("Validation error");
    await expect(startGateway()).rejects.toThrow("agent.maxConcurrent");
  });
});
