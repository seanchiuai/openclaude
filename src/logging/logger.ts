/**
 * Lightweight structured logger for the OpenClaude gateway.
 *
 * Writes JSON lines to the gateway log file and colored output to stderr.
 * Inspired by OpenClaw's logging subsystem but much simpler — no external deps.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  fatal: "\x1b[31m",  // red
  error: "\x1b[31m",  // red
  warn: "\x1b[33m",   // yellow
  info: "\x1b[36m",   // cyan
  debug: "\x1b[90m",  // gray
  trace: "\x1b[90m",  // gray
};

const RESET = "\x1b[0m";

let currentLevel: LogLevel = (process.env.OPENCLAUDE_LOG_LEVEL as LogLevel) ?? "info";
let fileReady = false;

function ensureLogDir(): void {
  if (fileReady) return;
  try {
    mkdirSync(dirname(paths.logFile), { recursive: true });
    fileReady = true;
  } catch {
    // Best effort
  }
}

function writeToFile(entry: Record<string, unknown>): void {
  ensureLogDir();
  try {
    appendFileSync(paths.logFile, JSON.stringify(entry) + "\n");
  } catch {
    // Never block on write failures
  }
}

function writeToConsole(level: LogLevel, subsystem: string, message: string): void {
  const color = LEVEL_COLORS[level];
  const prefix = `${color}[${subsystem}]${RESET}`;
  process.stderr.write(`${prefix} ${message}\n`);
}

export interface Logger {
  fatal(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  trace(message: string, meta?: Record<string, unknown>): void;
  child(name: string): Logger;
}

function isEnabled(level: LogLevel): boolean {
  return LEVEL_PRIORITY[level] <= LEVEL_PRIORITY[currentLevel];
}

export function createLogger(subsystem: string): Logger {
  function log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    if (!isEnabled(level)) return;

    const entry: Record<string, unknown> = {
      time: new Date().toISOString(),
      level,
      subsystem,
      message,
      ...meta,
    };

    writeToFile(entry);
    writeToConsole(level, subsystem, meta ? `${message} ${JSON.stringify(meta)}` : message);
  }

  return {
    fatal: (msg, meta) => log("fatal", msg, meta),
    error: (msg, meta) => log("error", msg, meta),
    warn: (msg, meta) => log("warn", msg, meta),
    info: (msg, meta) => log("info", msg, meta),
    debug: (msg, meta) => log("debug", msg, meta),
    trace: (msg, meta) => log("trace", msg, meta),
    child: (name) => createLogger(`${subsystem}/${name}`),
  };
}

/** Override the current log level at runtime. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}
