import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  writeFileSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, ensureDirectories, writeDefaultConfig } from "./loader.js";

const TEST_DIR = join(tmpdir(), "openclaude-test-config-" + process.pid);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("returns defaults when config file does not exist", () => {
    const config = loadConfig(join(TEST_DIR, "nonexistent.json"));
    expect(config.agent.maxConcurrent).toBe(4);
    expect(config.agent.defaultTimeout).toBe(300_000);
    expect(config.channels).toEqual({});
  });

  it("loads and validates a config file", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botToken: "test-token-123",
          },
        },
        agent: { maxConcurrent: 2 },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.channels.telegram?.enabled).toBe(true);
    expect(config.channels.telegram?.botToken).toBe("test-token-123");
    expect(config.agent.maxConcurrent).toBe(2);
  });

  it("substitutes environment variables", () => {
    const configPath = join(TEST_DIR, "config.json");
    process.env.TEST_BOT_TOKEN = "env-token-456";

    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botToken: "${TEST_BOT_TOKEN}",
          },
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.channels.telegram?.botToken).toBe("env-token-456");

    delete process.env.TEST_BOT_TOKEN;
  });

  it("throws on invalid config", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        agent: { maxConcurrent: -1 },
      }),
    );

    expect(() => loadConfig(configPath)).toThrow();
  });

  it("loads config with disabled channel missing env var (warning only)", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            enabled: false,
            botToken: "${TELEGRAM_BOT_TOKEN_MISSING_TEST}",
          },
        },
      }),
    );
    // Should NOT throw — channel is disabled
    const config = loadConfig(configPath);
    expect(config.channels.telegram?.enabled).toBe(false);
  });

  it("throws for enabled channel with missing env var", () => {
    const configPath = join(TEST_DIR, "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botToken: "${TELEGRAM_BOT_TOKEN_MISSING_TEST}",
          },
        },
      }),
    );
    expect(() => loadConfig(configPath)).toThrow(/TELEGRAM_BOT_TOKEN_MISSING_TEST/);
  });

  it("substitutes env vars using braced ${VAR} syntax", () => {
    const configPath = join(TEST_DIR, "config.json");
    process.env.TEST_BOT_TOKEN_BRACED = "braced-token";

    writeFileSync(
      configPath,
      JSON.stringify({
        channels: {
          telegram: {
            enabled: true,
            botToken: "${TEST_BOT_TOKEN_BRACED}",
          },
        },
      }),
    );

    const config = loadConfig(configPath);
    expect(config.channels.telegram?.botToken).toBe("braced-token");
    delete process.env.TEST_BOT_TOKEN_BRACED;
  });
});

describe("ensureDirectories", () => {
  beforeEach(() => {
    vi.mock("./paths.js", () => {
      const dir = join(tmpdir(), "openclaude-test-config-" + process.pid);
      return {
        paths: {
          base: join(dir, "base"),
          logs: join(dir, "logs"),
          sessions: join(dir, "sessions"),
          memory: join(dir, "memory"),
          cron: join(dir, "cron"),
          skills: join(dir, "skills"),
          workspace: join(dir, "workspace"),
          config: join(dir, "config.json"),
          memoryDb: join(dir, "memory", "openclaude.sqlite"),
          cronJobs: join(dir, "cron", "jobs.json"),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates all required directories", async () => {
    const { paths } = await import("./paths.js");
    ensureDirectories();

    const expectedDirs = [
      paths.base,
      paths.logs,
      paths.sessions,
      paths.memory,
      paths.cron,
      paths.skills,
      paths.workspace,
    ];

    for (const dir of expectedDirs) {
      expect(existsSync(dir)).toBe(true);
    }
  });

  it("does not throw when directories already exist", () => {
    ensureDirectories();
    expect(() => ensureDirectories()).not.toThrow();
  });
});

describe("writeDefaultConfig", () => {
  beforeEach(() => {
    vi.mock("./paths.js", () => {
      const dir = join(tmpdir(), "openclaude-test-config-" + process.pid);
      return {
        paths: {
          base: join(dir, "base"),
          logs: join(dir, "logs"),
          sessions: join(dir, "sessions"),
          memory: join(dir, "memory"),
          cron: join(dir, "cron"),
          skills: join(dir, "skills"),
          workspace: join(dir, "workspace"),
          config: join(dir, "writedefault", "config.json"),
          memoryDb: join(dir, "memory", "openclaude.sqlite"),
          cronJobs: join(dir, "cron", "jobs.json"),
        },
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates config file with valid JSON when file does not exist", async () => {
    const { paths } = await import("./paths.js");
    writeDefaultConfig();

    expect(existsSync(paths.config)).toBe(true);
    const content = readFileSync(paths.config, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("skips writing when config file already exists", async () => {
    const { paths } = await import("./paths.js");
    mkdirSync(join(TEST_DIR, "writedefault"), { recursive: true });
    writeFileSync(paths.config, '{"original": true}');

    writeDefaultConfig();

    const content = readFileSync(paths.config, "utf-8");
    expect(content).toBe('{"original": true}');
  });

  it("config file content ends with newline", async () => {
    const { paths } = await import("./paths.js");
    writeDefaultConfig();

    const content = readFileSync(paths.config, "utf-8");
    expect(content.endsWith("\n")).toBe(true);
  });

  it("config file content is valid OpenClaudeConfig", async () => {
    const { paths } = await import("./paths.js");
    writeDefaultConfig();

    const content = readFileSync(paths.config, "utf-8");
    const parsed = JSON.parse(content);

    expect(parsed).toHaveProperty("channels");
    expect(parsed).toHaveProperty("agent");
    expect(parsed).toHaveProperty("heartbeat");
    expect(parsed).toHaveProperty("mcp");
    expect(parsed).toHaveProperty("memory");
    expect(parsed.agent.maxConcurrent).toBe(4);
    expect(parsed.agent.defaultTimeout).toBe(300_000);
    expect(parsed.heartbeat.enabled).toBe(false);
  });
});
