/**
 * Config file loader for OpenClaude.
 * Extracted and simplified from OpenClaw's config/io.ts.
 *
 * Reads ~/.openclaude/config.json, substitutes env vars, validates with Zod.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.js";
import { substituteEnvVarsDeep } from "./env-substitution.js";
import { OpenClaudeConfigSchema } from "./schema.js";
import type { OpenClaudeConfig } from "./types.js";

const DEFAULT_CONFIG: OpenClaudeConfig = {
  channels: {},
  agent: {
    maxConcurrent: 4,
    defaultTimeout: 300_000,
  },
  heartbeat: {
    enabled: false,
    every: 1_800_000,
  },
  mcp: {},
  memory: {
    dbPath: paths.memoryDb,
  },
};

export function loadConfig(configPath?: string): OpenClaudeConfig {
  const filePath = configPath ?? paths.config;

  if (!existsSync(filePath)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);
  const substituted = substituteEnvVarsDeep(parsed);
  const validated = OpenClaudeConfigSchema.parse(substituted);

  return validated;
}

export function ensureDirectories(): void {
  const dirs = [
    paths.base,
    paths.logs,
    paths.sessions,
    paths.memory,
    paths.cron,
    paths.skills,
    paths.workspace,
  ];

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

export function writeDefaultConfig(): void {
  if (existsSync(paths.config)) {
    return;
  }

  mkdirSync(dirname(paths.config), { recursive: true });
  writeFileSync(paths.config, JSON.stringify(DEFAULT_CONFIG, null, 2) + "\n");
}
