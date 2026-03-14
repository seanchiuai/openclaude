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
  prompt?: string;
  ackMaxChars?: number;
  target?: {
    channel: "telegram" | "slack";
    chatId: string;
  };
  activeHours?: {
    start: string;
    end: string;
    timezone?: string;
  };
}

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface MemoryConfig {
  enabled: boolean;
  dbPath: string;
  sources: ("memory" | "sessions")[];
  extraPaths: string[];
  provider: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "auto" | "none";
  model?: string;
  outputDimensionality?: number;
  remote: {
    baseUrl?: string;
    apiKey?: string;
    headers?: Record<string, string>;
    batch: {
      enabled: boolean;
      wait: boolean;
      concurrency: number;
      pollIntervalMs: number;
      timeoutMinutes: number;
    };
  };
  local?: {
    modelPath?: string;
    modelCacheDir?: string;
  };
  fallback: "openai" | "local" | "gemini" | "voyage" | "mistral" | "ollama" | "none";
  store: {
    driver: "sqlite";
    path?: string;
    vector: {
      enabled: boolean;
      extensionPath?: string;
    };
  };
  chunking: {
    tokens: number;
    overlap: number;
  };
  sync: {
    onSessionStart: boolean;
    onSearch: boolean;
    watch: boolean;
    watchDebounceMs: number;
    intervalMinutes: number;
  };
  query: {
    maxResults: number;
    minScore: number;
    hybrid: {
      enabled: boolean;
      vectorWeight: number;
      textWeight: number;
      candidateMultiplier: number;
      mmr: {
        enabled: boolean;
        lambda: number;
      };
      temporalDecay: {
        enabled: boolean;
        halfLifeDays: number;
      };
    };
  };
  cache: {
    enabled: boolean;
    maxEntries?: number;
  };
  multimodal: {
    enabled: boolean;
  };
}

export interface CronConfig {
  enabled: boolean;
  storePath: string;
}

export interface GatewayAuthConfig {
  mode: "none" | "token";
  token?: string;
  rateLimit?: {
    maxAttempts: number;
    windowMs: number;
    lockoutMs: number;
  };
}

export interface GatewayConfig {
  port: number;
  auth: GatewayAuthConfig;
}

export interface OpenClaudeConfig {
  channels: ChannelsConfig;
  agent: AgentConfig;
  heartbeat: HeartbeatConfig;
  mcp: Record<string, McpServerConfig>;
  memory: MemoryConfig;
  cron: CronConfig;
  gateway: GatewayConfig;
}
