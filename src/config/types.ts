/**
 * OpenClaude configuration types.
 * Simplified from OpenClaw's config system.
 */

export interface TelegramChannelConfig {
  enabled: boolean;
  botToken: string;
  allowFrom?: string[];
  defaultTo?: string;
  mode?: "polling" | "webhook";
  webhookUrl?: string;
  requireMention?: boolean;
}

export interface SlackChannelConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  mode?: "socket" | "http";
  allowFrom?: string[];
}

export interface ChannelsConfig {
  telegram?: TelegramChannelConfig;
  slack?: SlackChannelConfig;
}

export interface AgentConfig {
  maxConcurrent: number;
  defaultTimeout: number;
  model?: string;
}

export interface HeartbeatConfig {
  enabled: boolean;
  every: number;
  target?: {
    channel: "telegram" | "slack";
    chatId: string;
  };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MemoryConfig {
  dbPath: string;
}

export interface CronConfig {
  enabled: boolean;
  storePath: string;
}

export interface OpenClaudeConfig {
  channels: ChannelsConfig;
  agent: AgentConfig;
  heartbeat: HeartbeatConfig;
  mcp: Record<string, McpServerConfig>;
  memory: MemoryConfig;
  cron: CronConfig;
}
