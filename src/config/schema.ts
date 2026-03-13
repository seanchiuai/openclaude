/**
 * Zod schemas for OpenClaude configuration validation.
 * Extracted and simplified from OpenClaw's config/zod-schema.ts.
 */
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
  target: z
    .object({
      channel: z.enum(["telegram", "slack"]),
      chatId: z.string(),
    })
    .optional(),
});

export const McpServerSchema = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string()).optional(),
});

export const MemorySchema = z.object({
  dbPath: z.string().default("~/.openclaude/memory/openclaude.sqlite"),
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
