/**
 * Standard paths for OpenClaude runtime data.
 */
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_DIR = join(homedir(), ".openclaude");

export const paths = {
  base: BASE_DIR,
  config: join(BASE_DIR, "config.json"),
  logs: join(BASE_DIR, "logs"),
  logFile: join(BASE_DIR, "logs", "gateway.log"),
  errLogFile: join(BASE_DIR, "logs", "gateway.err.log"),
  sessions: join(BASE_DIR, "sessions"),
  memory: join(BASE_DIR, "memory"),
  memoryDb: join(BASE_DIR, "memory", "openclaude.sqlite"),
  cron: join(BASE_DIR, "cron"),
  cronJobs: join(BASE_DIR, "cron", "jobs.json"),
  skills: join(BASE_DIR, "skills"),
  workspace: join(BASE_DIR, "workspace"),
  heartbeat: join(BASE_DIR, "HEARTBEAT.md"),
  pidFile: join(BASE_DIR, "gateway.pid"),
} as const;
