/**
 * Contract: Gateway Command Handlers
 *
 * Commands are handled directly without spawning Claude.
 * - /help returns command list with descriptions
 * - /list returns running sessions with IDs and elapsed time
 * - /list with no sessions returns "No active sessions"
 * - /stop <id> kills session, confirms
 * - /stop without args returns usage
 * - /stop nonexistent returns "not found"
 * - /status returns pool stats (running/max, queued)
 */
import { describe, it, expect, vi } from "vitest";
import { createCommandHandlers, GATEWAY_COMMANDS } from "./commands.js";

function createMockPool() {
  return {
    submit: vi.fn(),
    getSession: vi.fn(),
    listSessions: vi.fn().mockReturnValue([]),
    killSession: vi.fn().mockReturnValue(false),
    drain: vi.fn(),
    stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
  };
}

describe("GATEWAY_COMMANDS", () => {
  it("includes list, stop, status, help", () => {
    expect(GATEWAY_COMMANDS.has("list")).toBe(true);
    expect(GATEWAY_COMMANDS.has("stop")).toBe(true);
    expect(GATEWAY_COMMANDS.has("status")).toBe(true);
    expect(GATEWAY_COMMANDS.has("help")).toBe(true);
  });

  it("includes memory, memorysync, cron", () => {
    expect(GATEWAY_COMMANDS.has("memory")).toBe(true);
    expect(GATEWAY_COMMANDS.has("memorysync")).toBe(true);
    expect(GATEWAY_COMMANDS.has("cron")).toBe(true);
  });
});

describe("createCommandHandlers", () => {
  describe("/help", () => {
    it("returns text containing /list, /stop, /status, /help", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.help({ name: "help", args: "" });

      expect(result).toContain("/list");
      expect(result).toContain("/stop");
      expect(result).toContain("/status");
      expect(result).toContain("/help");
    });
  });

  describe("/list", () => {
    it("returns 'No active sessions.' when pool has no sessions", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.list({ name: "list", args: "" });

      expect(result).toContain("No active sessions");
    });

    it("returns session IDs and status when sessions exist", async () => {
      const pool = createMockPool();
      pool.listSessions.mockReturnValue([
        { id: "abc-123", status: "running", startedAt: Date.now() - 5000 },
        { id: "def-456", status: "queued", startedAt: Date.now() - 10000 },
      ]);
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.list({ name: "list", args: "" });

      expect(result).toContain("abc-123");
      expect(result).toContain("def-456");
      expect(result).toContain("running");
      expect(result).toContain("queued");
    });
  });

  describe("/stop", () => {
    it("returns usage when no args provided", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.stop({ name: "stop", args: "" });

      expect(result).toContain("Usage");
    });

    it("calls pool.killSession and returns 'stopped' for valid id", async () => {
      const pool = createMockPool();
      pool.killSession.mockReturnValue(true);
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.stop({ name: "stop", args: "abc-123" });

      expect(pool.killSession).toHaveBeenCalledWith("abc-123");
      expect(result).toContain("stopped");
    });

    it("returns 'not found' when pool.killSession returns false", async () => {
      const pool = createMockPool();
      pool.killSession.mockReturnValue(false);
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.stop({ name: "stop", args: "nonexistent" });

      expect(pool.killSession).toHaveBeenCalledWith("nonexistent");
      expect(result).toContain("not found");
    });
  });

  describe("/status", () => {
    it("returns pool stats with default values", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.status({ name: "status", args: "" });

      expect(result).toContain("Running: 0/4");
      expect(result).toContain("Queued: 0");
    });

    it("reflects correct counts when tasks are running", async () => {
      const pool = createMockPool();
      pool.stats.mockReturnValue({ running: 2, queued: 3, maxConcurrent: 4 });
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.status({ name: "status", args: "" });

      expect(result).toContain("Running: 2/4");
      expect(result).toContain("Queued: 3");
    });
  });

  describe("/memory", () => {
    it("returns not available when no memoryManager", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.memory({ name: "memory", args: "" });

      expect(result).toContain("not available");
    });

    it("returns memory status when memoryManager is provided", async () => {
      const pool = createMockPool();
      const mockMemory = {
        status: vi.fn().mockReturnValue({
          provider: "fts-only",
          files: 5,
          chunks: 20,
          dirty: false,
          dbPath: "/tmp/test.sqlite",
          fts: { enabled: true, available: true },
          vector: { enabled: false },
          cache: { enabled: false, entries: 0 },
        }),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        memoryManager: mockMemory as unknown as Parameters<typeof createCommandHandlers>[0]["memoryManager"],
      });
      const result = await handlers.memory({ name: "memory", args: "" });

      expect(result).toContain("Files: 5");
      expect(result).toContain("Chunks: 20");
      expect(result).toContain("fts-only");
    });
  });

  describe("/cron", () => {
    it("returns not available when no cronService", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.cron({ name: "cron", args: "" });

      expect(result).toContain("not available");
    });

    it("returns job list when cronService is provided", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([
          {
            id: "job-1",
            name: "backup",
            enabled: true,
            state: { lastRunAtMs: 1000 },
          },
        ]),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "list" });

      expect(result).toContain("job-1");
      expect(result).toContain("backup");
    });

    it("returns no jobs message when list is empty", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "" });

      expect(result).toContain("No cron jobs");
    });
  });

  describe("/cron add", () => {
    it("returns usage instructions containing schedule formats", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "add" });

      expect(result).toContain("Schedule formats");
    });
  });

  describe("/cron remove", () => {
    it("returns usage when no id provided", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "remove" });

      expect(result).toContain("Usage");
    });

    it("returns 'removed' when job exists", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn().mockReturnValue(true),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "remove job-1" });

      expect(mockCron.remove).toHaveBeenCalledWith("job-1");
      expect(result).toContain("removed");
    });

    it("returns 'not found' when job does not exist", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn().mockReturnValue(false),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "remove nonexistent" });

      expect(mockCron.remove).toHaveBeenCalledWith("nonexistent");
      expect(result).toContain("not found");
    });
  });

  describe("/cron run", () => {
    it("returns usage when no id provided", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "run" });

      expect(result).toContain("Usage");
    });

    it("returns 'completed' when run succeeds", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn().mockResolvedValue({ status: "ok", summary: "all good" }),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "run job-1" });

      expect(mockCron.run).toHaveBeenCalledWith("job-1");
      expect(result).toContain("completed");
    });

    it("returns error message when run fails", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn().mockResolvedValue({ status: "error", error: "timeout" }),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "run job-1" });

      expect(mockCron.run).toHaveBeenCalledWith("job-1");
      expect(result).toContain("error");
      expect(result).toContain("timeout");
    });
  });

  describe("/list with subagents", () => {
    it("shows subagent tree under parent sessions", async () => {
      const pool = createMockPool();
      pool.listSessions.mockReturnValue([
        { id: "main-abc", status: "running", startedAt: Date.now() - 5000 },
      ]);
      const registry = {
        getRunsForParent: vi.fn().mockReturnValue([
          { childSessionId: "sub-xyz", label: "research", status: "running", createdAt: Date.now() - 3000 },
          { childSessionId: "sub-def", label: "summarize", status: "completed", createdAt: Date.now() - 1000, duration: 1000 },
        ]),
        allRuns: vi.fn().mockReturnValue([]),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        subagentRegistry: registry as unknown as Parameters<typeof createCommandHandlers>[0]["subagentRegistry"],
      });
      const result = await handlers.list({ name: "list", args: "" });
      expect(result).toContain("sub-xyz");
      expect(result).toContain("research");
      expect(result).toContain("sub-def");
    });
  });

  describe("/stop with cascade", () => {
    it("kills parent and all active children", async () => {
      const pool = createMockPool();
      pool.killSession.mockReturnValue(true);
      const registry = {
        getActiveRunsForParent: vi.fn().mockReturnValue([
          { runId: "r1", childSessionId: "sub-xyz", status: "running" },
        ]),
        endRun: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        subagentRegistry: registry as unknown as Parameters<typeof createCommandHandlers>[0]["subagentRegistry"],
      });
      const result = await handlers.stop({ name: "stop", args: "main-abc" });
      expect(pool.killSession).toHaveBeenCalledWith("main-abc");
      expect(pool.killSession).toHaveBeenCalledWith("sub-xyz");
      expect(registry.endRun).toHaveBeenCalledWith("r1", "killed");
      expect(result).toContain("stopped");
      expect(result).toContain("subagent");
    });
  });

  describe("/cron unknown", () => {
    it("returns 'Unknown cron subcommand' for invalid subcommand", async () => {
      const pool = createMockPool();
      const mockCron = {
        list: vi.fn().mockReturnValue([]),
        remove: vi.fn(),
        run: vi.fn(),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        cronService: mockCron as unknown as Parameters<typeof createCommandHandlers>[0]["cronService"],
      });
      const result = await handlers.cron({ name: "cron", args: "foobar" });

      expect(result).toContain("Unknown cron subcommand");
    });
  });

  describe("/memorysync", () => {
    it("returns 'not available' when no memoryManager", async () => {
      const pool = createMockPool();
      const handlers = createCommandHandlers({ pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"] });
      const result = await handlers.memorysync({ name: "memorysync", args: "" });

      expect(result).toContain("not available");
    });

    it("returns 'sync complete' when memoryManager is provided", async () => {
      const pool = createMockPool();
      const mockMemory = {
        status: vi.fn(),
        sync: vi.fn().mockResolvedValue(undefined),
      };
      const handlers = createCommandHandlers({
        pool: pool as unknown as Parameters<typeof createCommandHandlers>[0]["pool"],
        memoryManager: mockMemory as unknown as Parameters<typeof createCommandHandlers>[0]["memoryManager"],
      });
      const result = await handlers.memorysync({ name: "memorysync", args: "" });

      expect(mockMemory.sync).toHaveBeenCalledWith({ force: true });
      expect(result).toContain("sync complete");
    });
  });
});
