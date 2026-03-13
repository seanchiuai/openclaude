import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
  markActivity,
} from "./diagnostic.js";

function createMockPool() {
  return {
    stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
    listSessions: vi.fn().mockReturnValue([]),
    submit: vi.fn(),
    drain: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
  };
}

function createMockCronService() {
  return {
    status: vi.fn().mockReturnValue({ running: true, jobCount: 2, enabledCount: 1 }),
    list: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(),
    run: vi.fn(),
    getJob: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
  };
}

describe("diagnostic heartbeat", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stopDiagnosticHeartbeat();
  });

  afterEach(() => {
    stopDiagnosticHeartbeat();
    vi.useRealTimers();
  });

  it("logs heartbeat after 30s when there is activity", () => {
    const pool = createMockPool();
    pool.stats.mockReturnValue({ running: 1, queued: 0, maxConcurrent: 4 });
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({
      pool: pool as never,
      startedAt: Date.now(),
    });

    vi.advanceTimersByTime(30_000);

    const heartbeatCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("heartbeat"),
    );
    expect(heartbeatCalls.length).toBeGreaterThanOrEqual(1);

    stderrWrite.mockRestore();
  });

  it("skips heartbeat when idle with no running sessions", () => {
    const pool = createMockPool();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({
      pool: pool as never,
      startedAt: Date.now() - 300_000, // started 5 min ago
    });

    // Advance past idle threshold (>2 min with no activity)
    vi.advanceTimersByTime(150_000);

    const heartbeatCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("heartbeat") && !c[0].includes("started"),
    );
    expect(heartbeatCalls.length).toBe(0);

    stderrWrite.mockRestore();
  });

  it("detects stuck sessions", () => {
    const pool = createMockPool();
    pool.stats.mockReturnValue({ running: 1, queued: 0, maxConcurrent: 4 });
    pool.listSessions.mockReturnValue([
      { id: "stuck-1", status: "running", startedAt: Date.now() - 180_000, pid: 123 },
    ]);
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({
      pool: pool as never,
      startedAt: Date.now(),
    });

    vi.advanceTimersByTime(30_000);

    const stuckCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("Session stuck"),
    );
    expect(stuckCalls.length).toBe(1);

    stderrWrite.mockRestore();
  });

  it("includes cron stats when cron service provided", () => {
    const pool = createMockPool();
    pool.stats.mockReturnValue({ running: 1, queued: 0, maxConcurrent: 4 });
    const cron = createMockCronService();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({
      pool: pool as never,
      cronService: cron as never,
      startedAt: Date.now(),
    });

    vi.advanceTimersByTime(30_000);

    expect(cron.status).toHaveBeenCalled();

    stderrWrite.mockRestore();
  });

  it("markActivity triggers heartbeat emission after idle period", () => {
    const pool = createMockPool();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({
      pool: pool as never,
      startedAt: Date.now() - 300_000,
    });

    // First 30s tick — idle, nothing running → skip
    vi.advanceTimersByTime(30_000);
    let heartbeatCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("heartbeat") && !c[0].includes("started"),
    );
    expect(heartbeatCalls.length).toBe(0);

    // Mark activity
    markActivity();

    // Next 30s tick — should emit because of recent activity
    vi.advanceTimersByTime(30_000);
    heartbeatCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("heartbeat") && !c[0].includes("started"),
    );
    expect(heartbeatCalls.length).toBe(1);

    stderrWrite.mockRestore();
  });

  it("does not start twice", () => {
    const pool = createMockPool();
    const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    startDiagnosticHeartbeat({ pool: pool as never, startedAt: Date.now() });
    startDiagnosticHeartbeat({ pool: pool as never, startedAt: Date.now() });

    const startCalls = stderrWrite.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0].includes("Diagnostic heartbeat started"),
    );
    expect(startCalls.length).toBe(1);

    stderrWrite.mockRestore();
  });
});
