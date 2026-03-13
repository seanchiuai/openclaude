import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock child_process before importing the module
vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(),
}));

import { spawnSync } from "node:child_process";
import {
  parsePidsFromLsofOutput,
  findGatewayPidsOnPortSync,
} from "./orphan-reaper.js";

const mockSpawnSync = vi.mocked(spawnSync);

describe("parsePidsFromLsofOutput", () => {
  it("parses lsof -Fpc output and filters to openclaude processes", () => {
    const output = "p1234\ncnode\np5678\ncopenclaude\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([5678]);
  });

  it("deduplicates PIDs from dual-stack listeners", () => {
    const output = "p1234\ncopenclaude\np1234\ncopenclaude\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([1234]);
  });

  it("excludes current process PID", () => {
    const output = `p${process.pid}\ncopenclaude\n`;
    expect(parsePidsFromLsofOutput(output)).toEqual([]);
  });

  it("returns empty array for empty output", () => {
    expect(parsePidsFromLsofOutput("")).toEqual([]);
  });

  it("handles output with no openclaude processes", () => {
    const output = "p1234\ncnode\np5678\ncpython\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([]);
  });

  it("handles multiple openclaude processes", () => {
    const output = "p1111\ncopenclaude\np2222\ncopenclaude\np3333\ncnode\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([1111, 2222]);
  });

  it("matches case-insensitively", () => {
    const output = "p1234\ncOpenClaude\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([1234]);
  });

  it("ignores invalid PID values", () => {
    const output = "pabc\ncopenclaude\np-1\ncopenclaude\n";
    expect(parsePidsFromLsofOutput(output)).toEqual([]);
  });
});

describe("findGatewayPidsOnPortSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Suppress console.error in tests
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns PIDs from lsof output", () => {
    mockSpawnSync.mockReturnValue({
      status: 0,
      stdout: "p9999\ncopenclaude\n",
      stderr: "",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([9999]);
  });

  it("returns empty array when lsof finds nothing (exit 1)", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
  });

  it("returns empty array on lsof error", () => {
    mockSpawnSync.mockReturnValue({
      status: null,
      stdout: "",
      stderr: "",
      error: Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
  });

  it("returns empty array on non-zero exit status", () => {
    mockSpawnSync.mockReturnValue({
      status: 2,
      stdout: "",
      stderr: "some error",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    expect(findGatewayPidsOnPortSync(45557)).toEqual([]);
  });

  it("passes correct lsof arguments", () => {
    mockSpawnSync.mockReturnValue({
      status: 1,
      stdout: "",
      stderr: "",
      error: undefined,
      pid: 0,
      output: [],
      signal: null,
    } as unknown as ReturnType<typeof spawnSync>);

    findGatewayPidsOnPortSync(12345);

    expect(mockSpawnSync).toHaveBeenCalledWith(
      "lsof",
      ["-nP", "-iTCP:12345", "-sTCP:LISTEN", "-Fpc"],
      expect.objectContaining({ encoding: "utf8", timeout: 2000 }),
    );
  });
});
