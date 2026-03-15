/**
 * Contract: Config Schema Validation
 *
 * The OpenClaudeConfigSchema validates configuration objects using Zod.
 * - Valid minimal config (empty object) passes with defaults applied
 * - Valid full config with all fields passes
 * - Missing required fields in channel configs fails validation
 * - Invalid types fail (e.g., maxConcurrent: "four")
 * - Defaults: maxConcurrent=4, defaultTimeout=300000, heartbeat.every=1800000
 * - Unknown fields are stripped (Zod default behavior)
 * - Env var substitution is handled upstream by substituteEnvVarsDeep
 */
import { describe, it, expect, afterEach } from "vitest";
import { OpenClaudeConfigSchema, TelegramChannelSchema, SlackChannelSchema, AgentSchema } from "./schema.js";
import { substituteEnvVarsDeep } from "./env-substitution.js";
import { paths } from "./paths.js";

describe("OpenClaudeConfigSchema", () => {
  it("valid minimal config passes with defaults", () => {
    const result = OpenClaudeConfigSchema.parse({});
    expect(result.agent.maxConcurrent).toBe(4);
    expect(result.agent.defaultTimeout).toBe(300_000);
    expect(result.heartbeat.enabled).toBe(false);
    expect(result.heartbeat.every).toBe(1_800_000);
    expect(result.channels).toEqual({});
    expect(result.mcp).toEqual({});
    expect(result.memory.dbPath).toBe(paths.memoryDb);
  });

  it("valid full config passes", () => {
    const full = {
      channels: {
        telegram: {
          enabled: true,
          botToken: "123:ABC",
          allowFrom: ["111", "222"],
          defaultTo: "111",
          mode: "polling" as const,
        },
        slack: {
          enabled: true,
          botToken: "xoxb-test",
          appToken: "xapp-test",
          mode: "socket" as const,
          allowFrom: ["U123"],
        },
      },
      agent: {
        maxConcurrent: 8,
        defaultTimeout: 600_000,
        model: "opus",
      },
      heartbeat: {
        enabled: true,
        every: 900_000,
        target: { channel: "telegram" as const, chatId: "111" },
      },
      mcp: {
        github: { command: "npx", args: ["@anthropic/github-mcp"] },
      },
      memory: {
        dbPath: "/custom/path.sqlite",
      },
    };

    const result = OpenClaudeConfigSchema.parse(full);
    expect(result.agent.maxConcurrent).toBe(8);
    expect(result.channels.telegram?.botToken).toBe("123:ABC");
    expect(result.channels.slack?.appToken).toBe("xapp-test");
    expect(result.heartbeat.target?.channel).toBe("telegram");
    expect(result.mcp.github.command).toBe("npx");
    expect(result.memory.dbPath).toBe("/custom/path.sqlite");
  });

  it("missing required field (botToken) in telegram fails", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        channels: {
          telegram: { enabled: true },
        },
      }),
    ).toThrow();
  });

  it("missing required field (appToken) in slack fails", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        channels: {
          slack: { enabled: true, botToken: "xoxb-test" },
        },
      }),
    ).toThrow();
  });

  it("invalid types fail — maxConcurrent as string", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        agent: { maxConcurrent: "four" },
      }),
    ).toThrow();
  });

  it("invalid types fail — defaultTimeout as boolean", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        agent: { defaultTimeout: true },
      }),
    ).toThrow();
  });

  it("invalid types fail — maxConcurrent out of range (0)", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        agent: { maxConcurrent: 0 },
      }),
    ).toThrow();
  });

  it("invalid types fail — maxConcurrent out of range (17)", () => {
    expect(() =>
      OpenClaudeConfigSchema.parse({
        agent: { maxConcurrent: 17 },
      }),
    ).toThrow();
  });

  it("defaults are applied for agent config", () => {
    const result = OpenClaudeConfigSchema.parse({ agent: {} });
    expect(result.agent.maxConcurrent).toBe(4);
    expect(result.agent.defaultTimeout).toBe(300_000);
    expect(result.agent.model).toBeUndefined();
  });

  it("defaults are applied for heartbeat config", () => {
    const result = OpenClaudeConfigSchema.parse({ heartbeat: {} });
    expect(result.heartbeat.enabled).toBe(false);
    expect(result.heartbeat.every).toBe(1_800_000);
    expect(result.heartbeat.target).toBeUndefined();
  });

  it("unknown fields are stripped", () => {
    const result = OpenClaudeConfigSchema.parse({
      unknownField: "should be gone",
      agent: { maxConcurrent: 2, extraField: true },
    } as Record<string, unknown>);

    expect(result.agent.maxConcurrent).toBe(2);
    expect((result as Record<string, unknown>).unknownField).toBeUndefined();
    expect((result.agent as Record<string, unknown>).extraField).toBeUndefined();
  });
});

describe("TelegramChannelSchema", () => {
  it("requires botToken", () => {
    expect(() => TelegramChannelSchema.parse({ enabled: true })).toThrow();
  });

  it("defaults mode to polling", () => {
    const result = TelegramChannelSchema.parse({
      botToken: "test",
    });
    expect(result.mode).toBe("polling");
    expect(result.enabled).toBe(false);
  });

  it("rejects invalid mode", () => {
    expect(() =>
      TelegramChannelSchema.parse({
        botToken: "test",
        mode: "invalid",
      }),
    ).toThrow();
  });
});

describe("SlackChannelSchema", () => {
  it("requires both botToken and appToken", () => {
    expect(() =>
      SlackChannelSchema.parse({ enabled: true, botToken: "xoxb" }),
    ).toThrow();
  });

  it("defaults mode to socket", () => {
    const result = SlackChannelSchema.parse({
      botToken: "xoxb-test",
      appToken: "xapp-test",
    });
    expect(result.mode).toBe("socket");
  });
});

describe("env var substitution integration", () => {
  afterEach(() => {
    delete process.env.OC_TEST_TOKEN;
    delete process.env.OC_TEST_APP;
  });

  it("${VAR} syntax substituted before validation", () => {
    process.env.OC_TEST_TOKEN = "real-token-123";
    const raw = {
      channels: {
        telegram: { enabled: true, botToken: "${OC_TEST_TOKEN}" },
      },
    };
    const substituted = substituteEnvVarsDeep(raw);
    const result = OpenClaudeConfigSchema.parse(substituted);
    expect(result.channels.telegram?.botToken).toBe("real-token-123");
  });

  it("${VAR} braced syntax substituted before validation", () => {
    process.env.OC_TEST_TOKEN = "braced-token";
    const raw = {
      channels: {
        telegram: { enabled: true, botToken: "${OC_TEST_TOKEN}" },
      },
    };
    const substituted = substituteEnvVarsDeep(raw);
    const result = OpenClaudeConfigSchema.parse(substituted);
    expect(result.channels.telegram?.botToken).toBe("braced-token");
  });

  it("nested env vars in deep config", () => {
    process.env.OC_TEST_TOKEN = "bot-tok";
    process.env.OC_TEST_APP = "app-tok";
    const raw = {
      channels: {
        slack: {
          enabled: true,
          botToken: "${OC_TEST_TOKEN}",
          appToken: "${OC_TEST_APP}",
        },
      },
    };
    const substituted = substituteEnvVarsDeep(raw);
    const result = OpenClaudeConfigSchema.parse(substituted);
    expect(result.channels.slack?.botToken).toBe("bot-tok");
    expect(result.channels.slack?.appToken).toBe("app-tok");
  });

  it("missing env var throws before validation", () => {
    const raw = {
      channels: {
        telegram: { enabled: true, botToken: "${NONEXISTENT_VAR_99999}" },
      },
    };
    expect(() => substituteEnvVarsDeep(raw)).toThrow("NONEXISTENT_VAR_99999");
  });
});
