/**
 * macOS LaunchAgent plist generation and management.
 * Extracted and simplified from OpenClaw's daemon/launchd.ts.
 */
import { execSync } from "node:child_process";
import { writeFileSync, existsSync, unlinkSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { paths } from "../config/paths.js";

const LABEL = "ai.openclaude.gateway";
const PLIST_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);

const LAUNCH_AGENT_DIR_MODE = 0o755;
const LAUNCH_AGENT_PLIST_MODE = 0o644;

export function buildPlist(nodePath: string, entryPath: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${entryPath}</string>
    <string>gateway</string>
    <string>run</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${paths.base}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>Umask</key>
  <integer>63</integer>
  <key>ThrottleInterval</key>
  <integer>1</integer>
  <key>StandardOutPath</key>
  <string>${paths.logFile}</string>
  <key>StandardErrorPath</key>
  <string>${paths.errLogFile}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin"}</string>
  </dict>
</dict>
</plist>`;
}

export function installLaunchAgent(
  nodePath: string,
  entryPath: string,
): void {
  const plist = buildPlist(nodePath, entryPath);
  mkdirSync(PLIST_DIR, { recursive: true, mode: LAUNCH_AGENT_DIR_MODE });
  writeFileSync(PLIST_PATH, plist, "utf-8");
  chmodSync(PLIST_PATH, LAUNCH_AGENT_PLIST_MODE);

  const uid = process.getuid?.();
  execSync(`launchctl bootstrap gui/${uid} "${PLIST_PATH}"`, {
    stdio: "ignore",
  });
}

export function uninstallLaunchAgent(): void {
  const uid = process.getuid?.();
  try {
    execSync(`launchctl bootout gui/${uid}/${LABEL}`, { stdio: "ignore" });
  } catch {
    // May not be loaded
  }
  if (existsSync(PLIST_PATH)) {
    unlinkSync(PLIST_PATH);
  }
}

export function stopLaunchAgent(): void {
  const uid = process.getuid?.();
  try {
    execSync(`launchctl kill SIGTERM gui/${uid}/${LABEL}`, {
      stdio: "ignore",
    });
  } catch {
    // May not be running
  }
}

export function isLaunchAgentLoaded(): boolean {
  const uid = process.getuid?.();
  try {
    execSync(`launchctl print gui/${uid}/${LABEL}`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

export function readLaunchAgentPid(): number | null {
  const uid = process.getuid?.();
  try {
    const output = execSync(`launchctl print gui/${uid}/${LABEL}`, {
      encoding: "utf-8",
    });
    const match = output.match(/pid\s*=\s*(\d+)/);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export { LABEL, PLIST_PATH };
