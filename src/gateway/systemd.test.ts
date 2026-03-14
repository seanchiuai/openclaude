/**
 * Tests for systemd service management.
 *
 * - buildSystemdUnit produces correct INI-style unit file content.
 * - installSystemdService writes unit, reloads daemon, enables, and restarts.
 * - uninstallSystemdService disables, removes unit, and reloads.
 * - readSystemdServicePid parses MainPID from systemctl show output.
 * - isSystemdServiceEnabled checks systemctl is-enabled exit code.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:child_process", () => ({
  execFile: vi.fn((_cmd: string, _args: string[], callback: (err: Error | null, stdout?: string, stderr?: string) => void) => {
    callback(null, "", "");
  }),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readFile: vi.fn(async () => ""),
  unlink: vi.fn(async () => undefined),
  copyFile: vi.fn(async () => { throw new Error("ENOENT"); }),
}));

import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile, unlink } from "node:fs/promises";
import {
  buildSystemdUnit,
  installSystemdService,
  uninstallSystemdService,
  stopSystemdService,
  restartSystemdService,
  isSystemdServiceEnabled,
  readSystemdServicePid,
  readSystemdServiceStatus,
  SERVICE_NAME,
  UNIT_NAME,
  UNIT_PATH,
} from "./systemd.js";

const mockExecFile = vi.mocked(execFileCb);
const mockMkdir = vi.mocked(mkdir);
const mockWriteFile = vi.mocked(writeFile);
const mockUnlink = vi.mocked(unlink);

function mockExecFileSuccess(stdout = "", stderr = "") {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      (callback as (err: null, stdout: string, stderr: string) => void)(null, stdout, stderr);
    }
    return undefined as unknown as ReturnType<typeof execFileCb>;
  });
}

function mockExecFileFailure(code = 1) {
  mockExecFile.mockImplementation((...args: unknown[]) => {
    const callback = args[args.length - 1];
    if (typeof callback === "function") {
      const err = new Error("failed") as Error & { code: number; stdout: string; stderr: string };
      err.code = code;
      err.stdout = "";
      err.stderr = "";
      (callback as (err: Error) => void)(err);
    }
    return undefined as unknown as ReturnType<typeof execFileCb>;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExecFileSuccess();
});

describe("buildSystemdUnit", () => {
  it("produces correct unit content with all sections", () => {
    const unit = buildSystemdUnit({
      description: "OpenClaude Gateway",
      execStart: ["/usr/bin/node", "/app/dist/cli/index.js", "gateway", "run"],
      workingDirectory: "/home/user",
      environment: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });

    expect(unit).toContain("[Unit]");
    expect(unit).toContain("Description=OpenClaude Gateway");
    expect(unit).toContain("[Service]");
    expect(unit).toContain("ExecStart=/usr/bin/node /app/dist/cli/index.js gateway run");
    expect(unit).toContain("Restart=always");
    expect(unit).toContain("RestartSec=5");
    expect(unit).toContain("KillMode=control-group");
    expect(unit).toContain("UMask=0077");
    expect(unit).toContain("WorkingDirectory=/home/user");
    expect(unit).toContain("Environment=PATH=/usr/local/bin:/usr/bin:/bin");
    expect(unit).toContain("[Install]");
    expect(unit).toContain("WantedBy=default.target");
  });

  it("omits WorkingDirectory when not provided", () => {
    const unit = buildSystemdUnit({
      description: "Test",
      execStart: ["/usr/bin/node"],
    });

    expect(unit).not.toContain("WorkingDirectory");
  });

  it("escapes arguments with spaces", () => {
    const unit = buildSystemdUnit({
      description: "Test",
      execStart: ["/usr/bin/node", "/path with spaces/app.js"],
    });

    expect(unit).toContain('"/path with spaces/app.js"');
  });
});

describe("installSystemdService", () => {
  it("creates directory, writes unit, reloads, enables, and restarts", async () => {
    await installSystemdService("/usr/bin/node", "/app/dist/cli/index.js");

    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".config/systemd/user"),
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      UNIT_PATH,
      expect.stringContaining("OpenClaude Gateway"),
      "utf-8",
    );

    // Should call systemctl daemon-reload, enable, restart
    const systemctlCalls = mockExecFile.mock.calls
      .filter(([cmd]) => cmd === "systemctl")
      .map(([, args]) => (args as string[]).slice(1).join(" "));

    expect(systemctlCalls).toContain("daemon-reload");
    expect(systemctlCalls).toContain(`enable ${UNIT_NAME}`);
    expect(systemctlCalls).toContain(`restart ${UNIT_NAME}`);
  });
});

describe("uninstallSystemdService", () => {
  it("disables, removes unit file, and reloads", async () => {
    await uninstallSystemdService();

    const systemctlCalls = mockExecFile.mock.calls
      .filter(([cmd]) => cmd === "systemctl")
      .map(([, args]) => (args as string[]).slice(1).join(" "));

    expect(systemctlCalls).toContain(`disable --now ${UNIT_NAME}`);
    expect(systemctlCalls).toContain("daemon-reload");
    expect(mockUnlink).toHaveBeenCalledWith(UNIT_PATH);
  });
});

describe("stopSystemdService", () => {
  it("calls systemctl stop", async () => {
    await stopSystemdService();

    expect(mockExecFile).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "stop", UNIT_NAME],
      expect.any(Function),
    );
  });
});

describe("restartSystemdService", () => {
  it("calls systemctl restart", async () => {
    await restartSystemdService();

    expect(mockExecFile).toHaveBeenCalledWith(
      "systemctl",
      ["--user", "restart", UNIT_NAME],
      expect.any(Function),
    );
  });
});

describe("isSystemdServiceEnabled", () => {
  it("returns true when systemctl is-enabled succeeds", async () => {
    expect(await isSystemdServiceEnabled()).toBe(true);
  });

  it("returns false when systemctl is-enabled fails", async () => {
    mockExecFileFailure(1);
    expect(await isSystemdServiceEnabled()).toBe(false);
  });
});

describe("readSystemdServicePid", () => {
  it("parses MainPID from systemctl show output", async () => {
    mockExecFileSuccess("MainPID=12345\n");
    expect(await readSystemdServicePid()).toBe(12345);
  });

  it("returns null when MainPID is 0", async () => {
    mockExecFileSuccess("MainPID=0\n");
    expect(await readSystemdServicePid()).toBeNull();
  });

  it("returns null when no MainPID in output", async () => {
    expect(await readSystemdServicePid()).toBeNull();
  });
});

describe("readSystemdServiceStatus", () => {
  it("parses active state and PID from systemctl show", async () => {
    mockExecFileSuccess("ActiveState=active\nSubState=running\nMainPID=42\n");

    const status = await readSystemdServiceStatus();
    expect(status.active).toBe(true);
    expect(status.state).toBe("running");
    expect(status.pid).toBe(42);
  });
});

describe("exports", () => {
  it("SERVICE_NAME is openclaude-gateway", () => {
    expect(SERVICE_NAME).toBe("openclaude-gateway");
  });

  it("UNIT_NAME ends with .service", () => {
    expect(UNIT_NAME).toBe("openclaude-gateway.service");
  });

  it("UNIT_PATH contains systemd/user path", () => {
    expect(UNIT_PATH).toMatch(/\.config\/systemd\/user\/openclaude-gateway\.service$/);
  });
});
