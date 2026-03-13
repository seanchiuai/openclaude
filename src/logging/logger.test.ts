import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const logDir = join(tmpdir(), `openclaude-logger-test-${process.pid}`);
const logFile = join(logDir, "gateway.log");

vi.mock("../config/paths.js", () => ({
  paths: {
    logFile: join(tmpdir(), `openclaude-logger-test-${process.pid}`, "gateway.log"),
  },
}));

const { createLogger, setLogLevel, enableFileWrites } = await import("./logger.js");

describe("createLogger", () => {
  beforeEach(() => {
    mkdirSync(logDir, { recursive: true });
    // Truncate log file
    try { rmSync(logFile); } catch { /* ok */ }
    setLogLevel("info");
    enableFileWrites(true);
  });

  afterAll(() => {
    enableFileWrites(false);
    rmSync(logDir, { recursive: true, force: true });
  });

  it("writes JSON lines to log file", () => {
    const log = createLogger("test");
    log.info("hello world");

    const content = readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.level).toBe("info");
    expect(entry.subsystem).toBe("test");
    expect(entry.message).toBe("hello world");
    expect(entry.time).toBeDefined();
  });

  it("includes metadata in log entry", () => {
    const log = createLogger("test");
    log.error("failed", { code: 500, path: "/api" });

    const content = readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.level).toBe("error");
    expect(entry.code).toBe(500);
    expect(entry.path).toBe("/api");
  });

  it("respects log level filtering", () => {
    setLogLevel("error");
    const log = createLogger("test");
    log.info("should be filtered");
    log.error("should appear");

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]).level).toBe("error");
  });

  it("child logger inherits subsystem prefix", () => {
    const log = createLogger("gateway");
    const child = log.child("http");
    child.info("request");

    const content = readFileSync(logFile, "utf-8").trim();
    const entry = JSON.parse(content);
    expect(entry.subsystem).toBe("gateway/http");
  });

  it("writes multiple entries as separate lines", () => {
    const log = createLogger("test");
    log.info("first");
    log.warn("second");
    log.error("third");

    const lines = readFileSync(logFile, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]).level).toBe("info");
    expect(JSON.parse(lines[1]).level).toBe("warn");
    expect(JSON.parse(lines[2]).level).toBe("error");
  });
});
