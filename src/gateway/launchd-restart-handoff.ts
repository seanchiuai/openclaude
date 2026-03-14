/**
 * Detached restart handoff for launchd-managed gateway processes.
 *
 * When the gateway needs to restart itself while running under launchd,
 * it cannot directly call `launchctl kickstart` because launchd will kill
 * the process mid-restart. Instead, we spawn a detached shell script that
 * waits for the caller PID to exit, then restarts via launchctl.
 *
 * Adapted from OpenClaw's daemon/launchd-restart-handoff.ts.
 */
import { spawn } from "node:child_process";

export type LaunchdRestartHandoffMode = "kickstart" | "start-after-exit";

export interface LaunchdRestartHandoffResult {
  ok: boolean;
  pid?: number;
  detail?: string;
}

/**
 * Check whether the current process was launched by launchd with the given label.
 * Looks at LAUNCH_JOB_LABEL, LAUNCH_JOB_NAME, and XPC_SERVICE_NAME env vars.
 */
export function isCurrentProcessLaunchdServiceLabel(
  label: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const launchdLabel =
    env.LAUNCH_JOB_LABEL?.trim() ||
    env.LAUNCH_JOB_NAME?.trim() ||
    env.XPC_SERVICE_NAME?.trim();
  if (launchdLabel) {
    return launchdLabel === label;
  }
  const configuredLabel = env.OPENCLAUDE_LAUNCHD_LABEL?.trim();
  return Boolean(configuredLabel && configuredLabel === label);
}

function resolveGuiDomain(): string {
  if (typeof process.getuid !== "function") {
    return "gui/501";
  }
  return `gui/${process.getuid()}`;
}

function buildRestartScript(mode: LaunchdRestartHandoffMode): string {
  const waitForCallerPid = `wait_pid="$4"
if [ -n "$wait_pid" ] && [ "$wait_pid" -gt 1 ] 2>/dev/null; then
  while kill -0 "$wait_pid" >/dev/null 2>&1; do
    sleep 0.1
  done
fi
`;

  if (mode === "kickstart") {
    return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl kickstart -k "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
  }

  return `service_target="$1"
domain="$2"
plist_path="$3"
${waitForCallerPid}
if ! launchctl start "$service_target" >/dev/null 2>&1; then
  launchctl enable "$service_target" >/dev/null 2>&1
  if launchctl bootstrap "$domain" "$plist_path" >/dev/null 2>&1; then
    launchctl start "$service_target" >/dev/null 2>&1 || launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  else
    launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true
  fi
fi
`;
}

/**
 * Spawn a detached shell process that waits for the caller to exit,
 * then restarts the LaunchAgent via launchctl.
 */
export function scheduleDetachedLaunchdRestartHandoff(params: {
  mode: LaunchdRestartHandoffMode;
  waitForPid?: number;
  label: string;
  plistPath: string;
}): LaunchdRestartHandoffResult {
  const domain = resolveGuiDomain();
  const serviceTarget = `${domain}/${params.label}`;
  const waitForPid =
    typeof params.waitForPid === "number" && Number.isFinite(params.waitForPid)
      ? Math.floor(params.waitForPid)
      : 0;

  try {
    const child = spawn(
      "/bin/sh",
      [
        "-c",
        buildRestartScript(params.mode),
        "openclaude-launchd-restart-handoff",
        serviceTarget,
        domain,
        params.plistPath,
        String(waitForPid),
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    return { ok: true, pid: child.pid ?? undefined };
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
