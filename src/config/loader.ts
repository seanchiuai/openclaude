/**
 * Config file loader for OpenClaude.
 * Extracted and simplified from OpenClaw's config/io.ts.
 *
 * Reads ~/.openclaude/config.json, substitutes env vars, validates with Zod.
 */
import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "./paths.js";
import { createLogger } from "../logging/logger.js";
import { resolveConfigEnvVars } from "./env-substitution.js";
import type { EnvSubstitutionWarning } from "./env-substitution.js";
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
    enabled: true,
    dbPath: paths.memoryDb,
    sources: ["memory"],
    extraPaths: [],
    provider: "none",
    fallback: "none",
    remote: {
      batch: {
        enabled: false,
        wait: true,
        concurrency: 2,
        pollIntervalMs: 2000,
        timeoutMinutes: 60,
      },
    },
    store: {
      driver: "sqlite",
      vector: { enabled: false },
    },
    chunking: { tokens: 400, overlap: 80 },
    sync: {
      onSessionStart: false,
      onSearch: true,
      watch: true,
      watchDebounceMs: 2000,
      intervalMinutes: 0,
    },
    query: {
      maxResults: 6,
      minScore: 0,
      hybrid: {
        enabled: true,
        vectorWeight: 0.7,
        textWeight: 0.3,
        candidateMultiplier: 4,
        mmr: { enabled: false, lambda: 0.5 },
        temporalDecay: { enabled: false, halfLifeDays: 30 },
      },
    },
    cache: { enabled: false },
    multimodal: { enabled: false },
  },
  cron: {
    enabled: false,
    storePath: "~/.openclaude/cron/jobs.json",
  },
  gateway: {
    port: 45557,
    auth: { mode: "none" },
  },
};

export function loadConfig(configPath?: string): OpenClaudeConfig {
  const filePath = configPath ?? paths.config;

  if (!existsSync(filePath)) {
    return DEFAULT_CONFIG;
  }

  const raw = readFileSync(filePath, "utf-8");
  const parsed: unknown = JSON.parse(raw);

  const envWarnings: EnvSubstitutionWarning[] = [];
  const substituted = resolveConfigEnvVars(parsed, process.env, {
    onMissing: (w) => envWarnings.push(w),
  });

  const validated = OpenClaudeConfigSchema.parse(substituted);

  validateEnabledChannelEnvVars(validated, envWarnings);

  // Log warnings for disabled channels (non-fatal)
  for (const w of envWarnings) {
    createLogger("config").warn(
      `env var \${${w.varName}} is not set (at ${w.configPath}). Ignored because channel is disabled.`,
    );
  }

  return validated;
}

function validateEnabledChannelEnvVars(
  config: OpenClaudeConfig,
  warnings: EnvSubstitutionWarning[],
): void {
  const enabledChannelPrefixes: string[] = [];
  if (config.channels.telegram?.enabled) {
    enabledChannelPrefixes.push("channels.telegram.");
  }
  if (config.channels.slack?.enabled) {
    enabledChannelPrefixes.push("channels.slack.");
  }
  for (const w of warnings) {
    const isEnabledChannel = enabledChannelPrefixes.some((prefix) =>
      w.configPath.startsWith(prefix),
    );
    if (isEnabledChannel) {
      throw new Error(
        `Channel config error: env var \${${w.varName}} is not set (at ${w.configPath}). ` +
          `Either set the env var or disable the channel.`,
      );
    }
  }
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
