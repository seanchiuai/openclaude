import { describe, it, expect } from "vitest";
import { resolveAlias, resolveModelForContext } from "./model.js";
import type { AgentConfig } from "../config/types.js";

const BASE_CONFIG: AgentConfig = {
  maxConcurrent: 4,
  defaultTimeout: 300_000,
};

describe("resolveAlias", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveAlias(undefined)).toBeUndefined();
  });

  it("resolves built-in aliases", () => {
    expect(resolveAlias("opus")).toBe("claude-opus-4-6");
    expect(resolveAlias("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveAlias("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("passes through unknown strings unchanged", () => {
    expect(resolveAlias("claude-sonnet-4-6")).toBe("claude-sonnet-4-6");
    expect(resolveAlias("custom-model-v1")).toBe("custom-model-v1");
  });

  it("user aliases override built-ins", () => {
    const userAliases = { opus: "claude-opus-4-7" };
    expect(resolveAlias("opus", userAliases)).toBe("claude-opus-4-7");
  });

  it("user aliases can define new names", () => {
    const userAliases = { fast: "claude-haiku-4-5-20251001" };
    expect(resolveAlias("fast", userAliases)).toBe("claude-haiku-4-5-20251001");
  });

  it("falls through to built-in when user alias doesn't match", () => {
    const userAliases = { fast: "claude-haiku-4-5-20251001" };
    expect(resolveAlias("sonnet", userAliases)).toBe("claude-sonnet-4-6");
  });
});

describe("resolveModelForContext", () => {
  it("returns undefined when nothing is configured", () => {
    expect(resolveModelForContext("user", BASE_CONFIG)).toBeUndefined();
  });

  it("task override wins over everything", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      model: "sonnet",
      cronModel: "haiku",
    };
    expect(resolveModelForContext("cron", config, "opus")).toBe("claude-opus-4-6");
  });

  it("context default wins over global default", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      model: "opus",
      heartbeatModel: "haiku",
    };
    expect(resolveModelForContext("heartbeat", config)).toBe("claude-haiku-4-5-20251001");
  });

  it("falls back to global default for user/skill contexts", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      model: "sonnet",
    };
    expect(resolveModelForContext("user", config)).toBe("claude-sonnet-4-6");
    expect(resolveModelForContext("skill", config)).toBe("claude-sonnet-4-6");
  });

  it("uses cronModel for cron context", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      cronModel: "haiku",
    };
    expect(resolveModelForContext("cron", config)).toBe("claude-haiku-4-5-20251001");
  });

  it("uses subagentModel for subagent context", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      subagentModel: "sonnet",
    };
    expect(resolveModelForContext("subagent", config)).toBe("claude-sonnet-4-6");
  });

  it("resolves aliases with user overrides in config", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      model: "fast",
      aliases: { fast: "claude-haiku-4-5-20251001" },
    };
    expect(resolveModelForContext("user", config)).toBe("claude-haiku-4-5-20251001");
  });

  it("returns undefined when context has no specific default and no global", () => {
    const config: AgentConfig = {
      ...BASE_CONFIG,
      heartbeatModel: "haiku",
    };
    expect(resolveModelForContext("user", config)).toBeUndefined();
    expect(resolveModelForContext("cron", config)).toBeUndefined();
  });
});
