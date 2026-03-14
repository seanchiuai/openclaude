/**
 * Tests for launchd restart handoff.
 *
 * - isCurrentProcessLaunchdServiceLabel detects launchd env vars.
 * - scheduleDetachedLaunchdRestartHandoff spawns a detached shell.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  spawn: vi.fn(),
}));

import { spawn } from "node:child_process";
import {
  isCurrentProcessLaunchdServiceLabel,
  scheduleDetachedLaunchdRestartHandoff,
} from "./launchd-restart-handoff.js";

const mockSpawn = vi.mocked(spawn);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isCurrentProcessLaunchdServiceLabel", () => {
  it("returns true when LAUNCH_JOB_LABEL matches", () => {
    const env = { LAUNCH_JOB_LABEL: "ai.openclaude.gateway" } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(true);
  });

  it("returns true when LAUNCH_JOB_NAME matches", () => {
    const env = { LAUNCH_JOB_NAME: "ai.openclaude.gateway" } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(true);
  });

  it("returns true when XPC_SERVICE_NAME matches", () => {
    const env = { XPC_SERVICE_NAME: "ai.openclaude.gateway" } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(true);
  });

  it("returns true when OPENCLAUDE_LAUNCHD_LABEL matches", () => {
    const env = { OPENCLAUDE_LAUNCHD_LABEL: "ai.openclaude.gateway" } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(true);
  });

  it("returns false when no env vars match", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(false);
  });

  it("returns false when label does not match", () => {
    const env = { LAUNCH_JOB_LABEL: "com.other.service" } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(false);
  });

  it("trims whitespace from env values", () => {
    const env = { LAUNCH_JOB_LABEL: "  ai.openclaude.gateway  " } as NodeJS.ProcessEnv;
    expect(isCurrentProcessLaunchdServiceLabel("ai.openclaude.gateway", env)).toBe(true);
  });
});

describe("scheduleDetachedLaunchdRestartHandoff", () => {
  it("spawns a detached shell with correct args for kickstart mode", () => {
    const mockChild = { unref: vi.fn(), pid: 12345 };
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    const result = scheduleDetachedLaunchdRestartHandoff({
      mode: "kickstart",
      waitForPid: 99999,
      label: "ai.openclaude.gateway",
      plistPath: "/Users/test/Library/LaunchAgents/ai.openclaude.gateway.plist",
    });

    expect(result.ok).toBe(true);
    expect(result.pid).toBe(12345);
    expect(mockSpawn).toHaveBeenCalledOnce();
    expect(mockSpawn).toHaveBeenCalledWith(
      "/bin/sh",
      expect.arrayContaining([
        "-c",
        expect.stringContaining("launchctl kickstart -k"),
        "openclaude-launchd-restart-handoff",
      ]),
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(mockChild.unref).toHaveBeenCalledOnce();
  });

  it("spawns with start-after-exit mode script", () => {
    const mockChild = { unref: vi.fn(), pid: 12346 };
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    const result = scheduleDetachedLaunchdRestartHandoff({
      mode: "start-after-exit",
      waitForPid: 99999,
      label: "ai.openclaude.gateway",
      plistPath: "/Users/test/Library/LaunchAgents/ai.openclaude.gateway.plist",
    });

    expect(result.ok).toBe(true);
    const script = mockSpawn.mock.calls[0][1]![1] as string;
    expect(script).toContain("launchctl start");
  });

  it("includes wait-for-pid polling in script", () => {
    const mockChild = { unref: vi.fn(), pid: 12347 };
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    scheduleDetachedLaunchdRestartHandoff({
      mode: "kickstart",
      waitForPid: 42,
      label: "ai.openclaude.gateway",
      plistPath: "/test.plist",
    });

    const script = mockSpawn.mock.calls[0][1]![1] as string;
    expect(script).toContain('kill -0 "$wait_pid"');
    expect(script).toContain("sleep 0.1");
  });

  it("passes waitForPid as string arg", () => {
    const mockChild = { unref: vi.fn(), pid: 12348 };
    mockSpawn.mockReturnValue(mockChild as unknown as ReturnType<typeof spawn>);

    scheduleDetachedLaunchdRestartHandoff({
      mode: "kickstart",
      waitForPid: 42,
      label: "ai.openclaude.gateway",
      plistPath: "/test.plist",
    });

    const args = mockSpawn.mock.calls[0][1] as string[];
    expect(args[args.length - 1]).toBe("42");
  });

  it("returns ok: false when spawn throws", () => {
    mockSpawn.mockImplementation(() => {
      throw new Error("spawn failed");
    });

    const result = scheduleDetachedLaunchdRestartHandoff({
      mode: "kickstart",
      label: "ai.openclaude.gateway",
      plistPath: "/test.plist",
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("spawn failed");
  });
});
