/**
 * Linux systemd user service management.
 *
 * Manages an openclaude-gateway.service unit under ~/.config/systemd/user/.
 * Simplified from OpenClaw's daemon/systemd.ts — no multi-profile, no machine
 * scope fallback, no EnvironmentFile parsing.
 */
import { execFile as execFileCb } from "node:child_process";
import { mkdir, writeFile, readFile, unlink, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

function execFileAsync(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFileCb(cmd, args, (err, stdout, stderr) => {
      if (err) {
        reject(Object.assign(err, { stdout: stdout ?? "", stderr: stderr ?? "" }));
      } else {
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    });
  });
}

const SERVICE_NAME = "openclaude-gateway";
const UNIT_NAME = `${SERVICE_NAME}.service`;
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT_PATH = join(UNIT_DIR, UNIT_NAME);

export function buildSystemdUnit(params: {
  description: string;
  execStart: string[];
  workingDirectory?: string;
  environment?: Record<string, string>;
}): string {
  const lines: string[] = [
    "[Unit]",
    `Description=${params.description}`,
    "",
    "[Service]",
    `ExecStart=${params.execStart.map(escapeArg).join(" ")}`,
    "Restart=always",
    "RestartSec=5",
    "KillMode=control-group",
    "UMask=0077",
  ];

  if (params.workingDirectory) {
    lines.push(`WorkingDirectory=${params.workingDirectory}`);
  }

  if (params.environment) {
    for (const [key, value] of Object.entries(params.environment)) {
      lines.push(`Environment=${key}=${value}`);
    }
  }

  lines.push("", "[Install]", "WantedBy=default.target", "");
  return lines.join("\n");
}

function escapeArg(arg: string): string {
  if (/[\s"'\\]/.test(arg)) {
    return `"${arg.replace(/["\\]/g, "\\$&")}"`;
  }
  return arg;
}

async function systemctl(...args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const result = await execFileAsync("systemctl", ["--user", ...args]);
    return { stdout: result.stdout, stderr: result.stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? "", stderr: e.stderr ?? "", code: e.code ?? 1 };
  }
}

export async function installSystemdService(
  nodePath: string,
  entryPath: string,
): Promise<void> {
  await mkdir(UNIT_DIR, { recursive: true });

  // Backup existing unit file
  try {
    await copyFile(UNIT_PATH, `${UNIT_PATH}.bak`);
  } catch {
    // No existing file to back up
  }

  const unit = buildSystemdUnit({
    description: "OpenClaude Gateway",
    execStart: [nodePath, entryPath, "gateway", "run"],
    workingDirectory: homedir(),
    environment: {
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    },
  });

  await writeFile(UNIT_PATH, unit, "utf-8");
  await systemctl("daemon-reload");
  await systemctl("enable", UNIT_NAME);
  await systemctl("restart", UNIT_NAME);
}

export async function uninstallSystemdService(): Promise<void> {
  await systemctl("disable", "--now", UNIT_NAME);
  try {
    await unlink(UNIT_PATH);
  } catch {
    // May not exist
  }
  await systemctl("daemon-reload");
}

export async function stopSystemdService(): Promise<void> {
  await systemctl("stop", UNIT_NAME);
}

export async function restartSystemdService(): Promise<void> {
  await systemctl("restart", UNIT_NAME);
}

export async function isSystemdServiceEnabled(): Promise<boolean> {
  const result = await systemctl("is-enabled", UNIT_NAME);
  return result.code === 0;
}

export async function readSystemdServicePid(): Promise<number | null> {
  const result = await systemctl("show", UNIT_NAME, "--property=MainPID");
  const match = result.stdout.match(/MainPID=(\d+)/);
  if (!match) return null;
  const pid = Number(match[1]);
  return pid > 0 ? pid : null;
}

export async function enableUserLinger(): Promise<void> {
  const user = process.env.USER ?? process.env.LOGNAME;
  if (!user) throw new Error("Cannot determine username for loginctl enable-linger");
  await execFileAsync("loginctl", ["enable-linger", user] as string[]);
}

export async function readSystemdServiceStatus(): Promise<{
  active: boolean;
  state?: string;
  pid: number | null;
}> {
  const result = await systemctl("show", UNIT_NAME, "--property=ActiveState,SubState,MainPID");
  const lines = result.stdout.split("\n");
  let activeState: string | undefined;
  let subState: string | undefined;
  let pid: number | null = null;
  for (const line of lines) {
    if (line.startsWith("ActiveState=")) activeState = line.slice("ActiveState=".length).trim();
    if (line.startsWith("SubState=")) subState = line.slice("SubState=".length).trim();
    if (line.startsWith("MainPID=")) {
      const n = Number(line.slice("MainPID=".length).trim());
      if (n > 0) pid = n;
    }
  }
  return {
    active: activeState === "active",
    state: subState ?? activeState,
    pid,
  };
}

export { SERVICE_NAME, UNIT_NAME, UNIT_PATH };
