/**
 * Orphan process reaper for OpenClaude gateway.
 * Adapted from OpenClaw's src/infra/restart-stale-pids.ts.
 *
 * Finds and kills stale gateway processes on the gateway port at startup,
 * then waits for the port to be released before proceeding.
 */
import { spawnSync } from "node:child_process";

const SPAWN_TIMEOUT_MS = 2000;
const STALE_SIGTERM_WAIT_MS = 600;
const STALE_SIGKILL_WAIT_MS = 400;
const PORT_FREE_POLL_INTERVAL_MS = 50;
const PORT_FREE_TIMEOUT_MS = 2000;
const POLL_SPAWN_TIMEOUT_MS = 400;

let sleepSyncOverride: ((ms: number) => void) | null = null;
let dateNowOverride: (() => number) | null = null;

function getTimeMs(): number {
  return dateNowOverride ? dateNowOverride() : Date.now();
}

function sleepSync(ms: number): void {
  const timeoutMs = Math.max(0, Math.floor(ms));
  if (timeoutMs <= 0) return;
  if (sleepSyncOverride) {
    sleepSyncOverride(timeoutMs);
    return;
  }
  try {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(lock, 0, 0, timeoutMs);
  } catch {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // Best-effort fallback
    }
  }
}

/**
 * Parse openclaude gateway PIDs from lsof -Fpc stdout.
 * Pure function — no I/O. Excludes the current process.
 */
export function parsePidsFromLsofOutput(stdout: string): number[] {
  const pids: number[] = [];
  let currentPid: number | undefined;
  let currentCmd: string | undefined;

  for (const line of stdout.split(/\r?\n/).filter(Boolean)) {
    if (line.startsWith("p")) {
      if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaude")) {
        pids.push(currentPid);
      }
      const parsed = Number.parseInt(line.slice(1), 10);
      currentPid = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      currentCmd = undefined;
    } else if (line.startsWith("c")) {
      currentCmd = line.slice(1);
    }
  }

  if (currentPid != null && currentCmd && currentCmd.toLowerCase().includes("openclaude")) {
    pids.push(currentPid);
  }

  return [...new Set(pids)].filter((pid) => pid !== process.pid);
}

/**
 * Find PIDs of gateway processes listening on the given port.
 */
export function findGatewayPidsOnPortSync(
  port: number,
  spawnTimeoutMs = SPAWN_TIMEOUT_MS,
): number[] {
  if (process.platform === "win32") return [];

  const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
    encoding: "utf8",
    timeout: spawnTimeoutMs,
  });

  if (res.error) {
    console.error(`[orphan-reaper] lsof failed: ${(res.error as NodeJS.ErrnoException).code ?? res.error.message}`);
    return [];
  }
  if (res.status === 1) return [];
  if (res.status !== 0) {
    console.error(`[orphan-reaper] lsof exited with status ${res.status}`);
    return [];
  }

  return parsePidsFromLsofOutput(res.stdout);
}

type PollResult = { free: true } | { free: false } | { free: null; permanent: boolean };

function pollPortOnce(port: number): PollResult {
  try {
    const res = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"], {
      encoding: "utf8",
      timeout: POLL_SPAWN_TIMEOUT_MS,
    });
    if (res.error) {
      const code = (res.error as NodeJS.ErrnoException).code;
      const permanent = code === "ENOENT" || code === "EACCES" || code === "EPERM";
      return { free: null, permanent };
    }
    if (res.status === 1) {
      if (res.stdout) {
        const pids = parsePidsFromLsofOutput(res.stdout);
        return pids.length === 0 ? { free: true } : { free: false };
      }
      return { free: true };
    }
    if (res.status !== 0) return { free: null, permanent: false };
    const pids = parsePidsFromLsofOutput(res.stdout);
    return pids.length === 0 ? { free: true } : { free: false };
  } catch {
    return { free: null, permanent: false };
  }
}

function terminateStaleProcessesSync(pids: number[]): number[] {
  const killed: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      killed.push(pid);
    } catch {
      // ESRCH — already gone
    }
  }
  if (killed.length === 0) return killed;

  sleepSync(STALE_SIGTERM_WAIT_MS);
  for (const pid of killed) {
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  sleepSync(STALE_SIGKILL_WAIT_MS);
  return killed;
}

function waitForPortFreeSync(port: number): void {
  const deadline = getTimeMs() + PORT_FREE_TIMEOUT_MS;
  while (getTimeMs() < deadline) {
    const result = pollPortOnce(port);
    if (result.free === true) return;
    if (result.free === null && result.permanent) return;
    sleepSync(PORT_FREE_POLL_INTERVAL_MS);
  }
  console.error(`[orphan-reaper] port ${port} still in use after ${PORT_FREE_TIMEOUT_MS}ms; proceeding anyway`);
}

/**
 * Kill stale gateway processes on the given port and wait for port release.
 * Call at gateway startup before binding the HTTP server.
 */
export function cleanStaleGatewayProcessesSync(port: number): number[] {
  try {
    const stalePids = findGatewayPidsOnPortSync(port);
    if (stalePids.length === 0) return [];

    console.error(
      `[orphan-reaper] killing ${stalePids.length} stale gateway process(es): ${stalePids.join(", ")}`,
    );
    const killed = terminateStaleProcessesSync(stalePids);
    waitForPortFreeSync(port);
    return killed;
  } catch {
    return [];
  }
}

export const __testing = {
  setSleepSyncOverride(fn: ((ms: number) => void) | null) {
    sleepSyncOverride = fn;
  },
  setDateNowOverride(fn: (() => number) | null) {
    dateNowOverride = fn;
  },
};
