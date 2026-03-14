/**
 * Contract tests for the launchd module.
 *
 * - buildPlist produces valid plist XML with correct label, paths, and config values.
 * - installLaunchAgent writes the plist file and bootstraps the agent via launchctl.
 * - uninstallLaunchAgent boots out the agent and removes the plist file, tolerating errors.
 * - stopLaunchAgent sends SIGTERM via launchctl, tolerating errors.
 * - isLaunchAgentLoaded returns true/false based on launchctl print success.
 * - readLaunchAgentPid extracts PID from launchctl print output, or returns null.
 * - LABEL and PLIST_PATH exports have expected values.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

vi.mock("node:fs", () => ({
  writeFileSync: vi.fn(),
  existsSync: vi.fn(),
  unlinkSync: vi.fn(),
  readFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  chmodSync: vi.fn(),
  renameSync: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  paths: {
    base: "/mock/base/path",
    logFile: "/mock/logs/gateway.log",
    errLogFile: "/mock/logs/gateway.err.log",
  },
}));

import { execSync } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync, mkdirSync, chmodSync } from "node:fs";
import {
  buildPlist,
  installLaunchAgent,
  uninstallLaunchAgent,
  stopLaunchAgent,
  isLaunchAgentLoaded,
  readLaunchAgentPid,
  findLegacyLaunchAgents,
  uninstallLegacyLaunchAgents,
  LABEL,
  PLIST_PATH,
} from "./launchd.js";

const mockExecSync = vi.mocked(execSync);
const mockWriteFileSync = vi.mocked(writeFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockUnlinkSync = vi.mocked(unlinkSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockChmodSync = vi.mocked(chmodSync);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildPlist", () => {
  it("contains the correct label, node path, entry path, and config paths", () => {
    const result = buildPlist("/usr/local/bin/node", "/app/dist/index.js");

    expect(result).toContain("<string>ai.openclaude.gateway</string>");
    expect(result).toContain("<string>/usr/local/bin/node</string>");
    expect(result).toContain("<string>/app/dist/index.js</string>");
    expect(result).toContain("<string>/mock/base/path</string>");
    expect(result).toContain("<string>/mock/logs/gateway.log</string>");
    expect(result).toContain("<string>/mock/logs/gateway.err.log</string>");
  });

  it("produces valid XML structure", () => {
    const result = buildPlist("/usr/local/bin/node", "/app/dist/index.js");

    expect(result).toMatch(/^<\?xml version="1\.0" encoding="UTF-8"\?>/);
    expect(result).toContain("<!DOCTYPE plist");
    expect(result).toContain('<plist version="1.0">');
    expect(result).toContain("</plist>");
    expect(result).toContain("</dict>");
  });

  it("contains Umask and ThrottleInterval for security hardening", () => {
    const result = buildPlist("/usr/local/bin/node", "/app/dist/index.js");

    expect(result).toContain("<key>Umask</key>");
    expect(result).toContain("<integer>63</integer>");
    expect(result).toContain("<key>ThrottleInterval</key>");
    expect(result).toContain("<integer>1</integer>");
  });
});

describe("installLaunchAgent", () => {
  it("writes the plist file and calls launchctl bootstrap", () => {
    const uid = process.getuid?.();

    installLaunchAgent("/usr/local/bin/node", "/app/dist/index.js");

    expect(mockWriteFileSync).toHaveBeenCalledOnce();
    expect(mockWriteFileSync).toHaveBeenCalledWith(
      PLIST_PATH,
      expect.stringContaining("ai.openclaude.gateway"),
      "utf-8",
    );

    expect(mockExecSync).toHaveBeenCalledOnce();
    expect(mockExecSync).toHaveBeenCalledWith(
      `launchctl bootstrap gui/${uid} "${PLIST_PATH}"`,
      { stdio: "ignore" },
    );
  });

  it("creates plist directory with correct permissions and chmods the file", () => {
    installLaunchAgent("/usr/local/bin/node", "/app/dist/index.js");

    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining("LaunchAgents"),
      { recursive: true, mode: 0o755 },
    );
    expect(mockChmodSync).toHaveBeenCalledWith(PLIST_PATH, 0o644);
  });
});

describe("uninstallLaunchAgent", () => {
  it("calls launchctl bootout and removes the plist file", () => {
    const uid = process.getuid?.();
    mockExistsSync.mockReturnValue(true);

    uninstallLaunchAgent();

    expect(mockExecSync).toHaveBeenCalledWith(
      `launchctl bootout gui/${uid}/${LABEL}`,
      { stdio: "ignore" },
    );
    expect(mockUnlinkSync).toHaveBeenCalledWith(PLIST_PATH);
  });

  it("ignores bootout error and still removes the file", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not loaded");
    });
    mockExistsSync.mockReturnValue(true);

    expect(() => uninstallLaunchAgent()).not.toThrow();
    expect(mockUnlinkSync).toHaveBeenCalledWith(PLIST_PATH);
  });

  it("skips unlinkSync when plist file does not exist", () => {
    mockExistsSync.mockReturnValue(false);

    uninstallLaunchAgent();

    expect(mockUnlinkSync).not.toHaveBeenCalled();
  });
});

describe("stopLaunchAgent", () => {
  it("calls launchctl kill SIGTERM", () => {
    const uid = process.getuid?.();

    stopLaunchAgent();

    expect(mockExecSync).toHaveBeenCalledWith(
      `launchctl kill SIGTERM gui/${uid}/${LABEL}`,
      { stdio: "ignore" },
    );
  });

  it("ignores error when agent is not running", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not running");
    });

    expect(() => stopLaunchAgent()).not.toThrow();
  });
});

describe("isLaunchAgentLoaded", () => {
  it("returns true when launchctl print succeeds", () => {
    mockExecSync.mockReturnValue(Buffer.from(""));

    expect(isLaunchAgentLoaded()).toBe(true);
  });

  it("returns false when launchctl print throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("could not find service");
    });

    expect(isLaunchAgentLoaded()).toBe(false);
  });
});

describe("readLaunchAgentPid", () => {
  it("returns the pid when output contains 'pid = 12345'", () => {
    mockExecSync.mockReturnValue("some output\npid = 12345\nmore output");

    expect(readLaunchAgentPid()).toBe(12345);
  });

  it("returns null when output has no pid match", () => {
    mockExecSync.mockReturnValue("some output without pid info");

    expect(readLaunchAgentPid()).toBeNull();
  });

  it("returns null when launchctl print throws", () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("could not find service");
    });

    expect(readLaunchAgentPid()).toBeNull();
  });
});

describe("findLegacyLaunchAgents", () => {
  it("returns empty array when no legacy labels are defined", () => {
    expect(findLegacyLaunchAgents()).toEqual([]);
  });
});

describe("uninstallLegacyLaunchAgents", () => {
  it("returns empty array when no legacy labels are defined", () => {
    expect(uninstallLegacyLaunchAgents()).toEqual([]);
  });
});

describe("exports", () => {
  it("LABEL is ai.openclaude.gateway", () => {
    expect(LABEL).toBe("ai.openclaude.gateway");
  });

  it("PLIST_PATH ends with the expected filename", () => {
    expect(PLIST_PATH).toMatch(/Library\/LaunchAgents\/ai\.openclaude\.gateway\.plist$/);
  });
});
