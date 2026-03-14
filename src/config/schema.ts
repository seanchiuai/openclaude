import { z } from "zod";

export const TelegramChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().min(1),
  allowFrom: z.array(z.string()).optional(),
  defaultTo: z.string().optional(),
  mode: z.enum(["polling", "webhook"]).default("polling"),
  webhookUrl: z.string().url().optional(),
  requireMention: z.boolean().default(true),
});

export const SlackChannelSchema = z.object({
  enabled: z.boolean().default(false),
  botToken: z.string().min(1),
  appToken: z.string().min(1),
  mode: z.enum(["socket", "http"]).default("socket"),
  allowFrom: z.array(z.string()).optional(),
});

export const ChannelsSchema = z.object({
  telegram: TelegramChannelSchema.optional(),
  slack: SlackChannelSchema.optional(),
});

export const AgentSchema = z.object({
  maxConcurrent: z.number().int().min(1).max(16).default(4),
  defaultTimeout: z.number().int().min(10_000).default(300_000),
  model: z.string().optional(),
});

export const HeartbeatSchema = z.object({
  enabled: z.boolean().default(false),
  every: z.number().int().min(60_000).default(1_800_000),
  prompt: z.string().optional(),
  ackMaxChars: z.number().int().min(0).default(300),
  target: z
    .object({
      channel: z.enum(["telegram", "slack"]),
      chatId: z.string(),
    })
    .optional(),
  activeHours: z
    .object({
      start: z.string(),
      end: z.string(),
      timezone: z.string().optional(),
    })
    .optional(),
});

export const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const MemorySchema = z.object({
  enabled: z.boolean().default(true),
  dbPath: z.string().default("~/.openclaude/memory/openclaude.sqlite"),
  sources: z.array(z.enum(["memory", "sessions"])).default(["memory"]),
  extraPaths: z.array(z.string()).default([]),
  provider: z.enum(["openai", "local", "gemini", "voyage", "mistral", "ollama", "auto", "none"]).default("none"),
  model: z.string().optional(),
  outputDimensionality: z.number().optional(),
  remote: z.object({
    baseUrl: z.string().optional(),
    apiKey: z.string().optional(),
    headers: z.record(z.string()).optional(),
    batch: z.object({
      enabled: z.boolean().default(true),
      wait: z.boolean().default(true),
      concurrency: z.number().default(2),
      pollIntervalMs: z.number().default(5000),
      timeoutMinutes: z.number().default(60),
    }).default({}),
  }).default({}),
  local: z.object({
    modelPath: z.string().optional(),
    modelCacheDir: z.string().optional(),
  }).optional(),
  fallback: z.enum(["openai", "local", "gemini", "voyage", "mistral", "ollama", "none"]).default("none"),
  store: z.object({
    driver: z.literal("sqlite").default("sqlite"),
    path: z.string().optional(),
    vector: z.object({
      enabled: z.boolean().default(true),
      extensionPath: z.string().optional(),
    }).default({}),
  }).default({}),
  chunking: z.object({
    tokens: z.number().default(400),
    overlap: z.number().default(80),
  }).default({}),
  sync: z.object({
    onSessionStart: z.boolean().default(true),
    onSearch: z.boolean().default(true),
    watch: z.boolean().default(false),
    watchDebounceMs: z.number().default(500),
    intervalMinutes: z.number().default(5),
  }).default({}),
  query: z.object({
    maxResults: z.number().default(6),
    minScore: z.number().default(0.35),
    hybrid: z.object({
      enabled: z.boolean().default(true),
      vectorWeight: z.number().default(0.7),
      textWeight: z.number().default(0.3),
      candidateMultiplier: z.number().default(4),
      mmr: z.object({
        enabled: z.boolean().default(false),
        lambda: z.number().default(0.7),
      }).default({}),
      temporalDecay: z.object({
        enabled: z.boolean().default(false),
        halfLifeDays: z.number().default(30),
      }).default({}),
    }).default({}),
  }).default({}),
  cache: z.object({
    enabled: z.boolean().default(true),
    maxEntries: z.number().optional(),
  }).default({}),
  multimodal: z.object({
    enabled: z.boolean().default(false),
  }).default({}),
});

export const CronSchema = z.object({
  enabled: z.boolean().default(false),
  storePath: z.string().default("~/.openclaude/cron/jobs.json"),
});

export const GatewayAuthSchema = z.object({
  mode: z.enum(["none", "token"]).default("none"),
  token: z.string().optional(),
  rateLimit: z.object({
    maxAttempts: z.number().int().min(1).default(10),
    windowMs: z.number().int().min(1000).default(60_000),
    lockoutMs: z.number().int().min(1000).default(300_000),
  }).optional(),
});

export const GatewaySchema = z.object({
  port: z.number().int().default(45557),
  auth: GatewayAuthSchema.default({}),
});

export const OpenClaudeConfigSchema = z.object({
  channels: ChannelsSchema.default({}),
  agent: AgentSchema.default({}),
  heartbeat: HeartbeatSchema.default({}),
  mcp: z.record(McpServerSchema).default({}),
  memory: MemorySchema.default({}),
  cron: CronSchema.default({}),
  gateway: GatewaySchema.default({}),
});

export type ValidatedConfig = z.infer<typeof OpenClaudeConfigSchema>;
