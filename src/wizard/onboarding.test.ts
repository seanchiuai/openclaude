import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { WizardPrompter, WizardProgress } from "./prompts.js";

// Mock paths to use temp dir
let tmpDir: string;

vi.mock("../config/paths.js", async () => {
  // We need the tmpDir but it's set in beforeEach, so use a getter
  return {
    get paths() {
      return {
        base: tmpDir,
        config: join(tmpDir, "config.json"),
        logs: join(tmpDir, "logs"),
        logFile: join(tmpDir, "logs", "gateway.log"),
        errLogFile: join(tmpDir, "logs", "gateway.err.log"),
        sessions: join(tmpDir, "sessions"),
        memory: join(tmpDir, "memory"),
        memoryDb: join(tmpDir, "memory", "openclaude.sqlite"),
        cron: join(tmpDir, "cron"),
        cronJobs: join(tmpDir, "cron", "jobs.json"),
        skills: join(tmpDir, "skills"),
        workspace: join(tmpDir, "workspace"),
        heartbeat: join(tmpDir, "HEARTBEAT.md"),
        pidFile: join(tmpDir, "gateway.pid"),
        sessionsMap: join(tmpDir, "sessions-map.json"),
      };
    },
  };
});

// Mock helpers
vi.mock("./helpers.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    detectClaudeCli: vi.fn().mockResolvedValue("1.0.0"),
    testTelegramToken: vi.fn().mockResolvedValue({ ok: true, username: "test_bot" }),
    testSlackToken: vi.fn().mockResolvedValue({ ok: true, botName: "test-slack-bot" }),
  };
});

/**
 * Create a test prompter that returns pre-configured answers in sequence.
 */
function createTestPrompter(answers: {
  selects?: unknown[];
  texts?: string[];
  confirms?: boolean[];
}): WizardPrompter {
  let selectIdx = 0;
  let textIdx = 0;
  let confirmIdx = 0;

  const noopProgress: WizardProgress = {
    update: () => {},
    stop: () => {},
  };

  return {
    intro: async () => {},
    outro: async () => {},
    note: async () => {},
    select: async () => {
      const val = answers.selects?.[selectIdx] ?? "none";
      selectIdx++;
      return val as never;
    },
    multiselect: async () => [],
    text: async () => {
      const val = answers.texts?.[textIdx] ?? "";
      textIdx++;
      return val;
    },
    confirm: async () => {
      const val = answers.confirms?.[confirmIdx] ?? true;
      confirmIdx++;
      return val;
    },
    progress: (): WizardProgress => noopProgress,
  };
}

describe("onboarding wizard", () => {
  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "oc-wizard-test-"));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates config with telegram channel", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");

    const prompter = createTestPrompter({
      selects: ["telegram", "none"], // channel choice, memory provider
      texts: ["123456:ABC-DEF"], // telegram token
      confirms: [false], // don't start gateway
    });

    const result = await runOnboardingWizard(prompter);
    expect(result.channels).toBe("telegram");
    expect(result.memoryProvider).toBe("none");

    const config = JSON.parse(await readFile(join(tmpDir, "config.json"), "utf-8"));
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.telegram.botToken).toBe("123456:ABC-DEF");
    expect(config.channels.slack).toBeUndefined();
  });

  it("generates config with slack channel", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");

    const prompter = createTestPrompter({
      selects: ["slack", "none"], // channel choice, memory provider
      texts: ["xoxb-test-token", "xapp-test-token"], // slack bot + app tokens
      confirms: [false], // don't start gateway
    });

    const result = await runOnboardingWizard(prompter);
    expect(result.channels).toBe("slack");

    const config = JSON.parse(await readFile(join(tmpDir, "config.json"), "utf-8"));
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.channels.slack.botToken).toBe("xoxb-test-token");
    expect(config.channels.slack.appToken).toBe("xapp-test-token");
    expect(config.channels.telegram).toBeUndefined();
  });

  it("generates config with both channels", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");

    const prompter = createTestPrompter({
      selects: ["both", "openai"], // channel choice, memory provider
      texts: ["tg-token", "xoxb-token", "xapp-token"], // telegram + slack tokens
      confirms: [false], // don't start gateway
    });

    const result = await runOnboardingWizard(prompter);
    expect(result.channels).toBe("both");
    expect(result.memoryProvider).toBe("openai");

    const config = JSON.parse(await readFile(join(tmpDir, "config.json"), "utf-8"));
    expect(config.channels.telegram.enabled).toBe(true);
    expect(config.channels.slack.enabled).toBe(true);
    expect(config.memory.provider).toBe("openai");
    expect(config.memory.store.vector.enabled).toBe(true);
  });

  it("generates config with no channels", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");

    const prompter = createTestPrompter({
      selects: ["none", "none"], // no channels, no memory provider
      confirms: [false], // don't start gateway
    });

    const result = await runOnboardingWizard(prompter);
    expect(result.channels).toBe("none");

    const config = JSON.parse(await readFile(join(tmpDir, "config.json"), "utf-8"));
    expect(config.channels).toEqual({});
  });

  it("creates required directories", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");
    const { existsSync } = await import("node:fs");

    const prompter = createTestPrompter({
      selects: ["none", "none"],
      confirms: [false],
    });

    await runOnboardingWizard(prompter);

    expect(existsSync(join(tmpDir, "logs"))).toBe(true);
    expect(existsSync(join(tmpDir, "sessions"))).toBe(true);
    expect(existsSync(join(tmpDir, "memory"))).toBe(true);
    expect(existsSync(join(tmpDir, "cron"))).toBe(true);
    expect(existsSync(join(tmpDir, "skills"))).toBe(true);
  });

  it("enables vector search when memory provider is not none", async () => {
    const { runOnboardingWizard } = await import("./onboarding.js");

    const prompter = createTestPrompter({
      selects: ["none", "ollama"],
      confirms: [false],
    });

    const result = await runOnboardingWizard(prompter);
    expect(result.memoryProvider).toBe("ollama");

    const config = JSON.parse(await readFile(join(tmpDir, "config.json"), "utf-8"));
    expect(config.memory.store.vector.enabled).toBe(true);
  });
});
