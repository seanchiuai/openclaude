/**
 * Interactive onboarding wizard for OpenClaude.
 *
 * Flow:
 * 1. Welcome + pre-flight check (claude CLI installed?)
 * 2. Channel selection (Telegram / Slack / both / neither)
 * 3. Token prompts per selected channel + connection test
 * 4. Memory provider choice
 * 5. Write config + create directories
 * 6. Offer to start the gateway
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { paths } from "../config/paths.js";
import type { WizardPrompter } from "./prompts.js";
import {
  printWizardHeader,
  detectClaudeCli,
  testTelegramToken,
  testSlackToken,
  validateToken,
} from "./helpers.js";

type ChannelChoice = "telegram" | "slack" | "both" | "none";
type MemoryProvider = "none" | "openai" | "ollama" | "gemini" | "voyage" | "mistral";

export interface OnboardingResult {
  configPath: string;
  channels: ChannelChoice;
  memoryProvider: MemoryProvider;
}

export async function runOnboardingWizard(
  prompter: WizardPrompter,
): Promise<OnboardingResult> {
  printWizardHeader();
  await prompter.intro("Welcome to OpenClaude setup");

  // --- Step 1: Pre-flight check ---
  const cliProgress = prompter.progress("Checking for Claude CLI...");
  const cliVersion = await detectClaudeCli();

  if (cliVersion) {
    cliProgress.stop(`Claude CLI found: ${cliVersion}`);
  } else {
    cliProgress.stop("Claude CLI not found");
    await prompter.note(
      "OpenClaude requires the Claude Code CLI.\n" +
        "Install it from: https://docs.anthropic.com/en/docs/claude-code/overview\n\n" +
        "You can continue setup and install it later.",
      "Warning",
    );
    const continueAnyway = await prompter.confirm({
      message: "Continue setup without Claude CLI?",
      initialValue: true,
    });
    if (!continueAnyway) {
      await prompter.outro("Setup cancelled. Install Claude CLI and try again.");
      process.exit(0);
    }
  }

  // --- Step 2: Channel selection ---
  const channelChoice = await prompter.select<ChannelChoice>({
    message: "Which messaging channels do you want to connect?",
    options: [
      { value: "telegram", label: "Telegram", hint: "Long-polling bot" },
      { value: "slack", label: "Slack", hint: "Socket Mode app" },
      { value: "both", label: "Both Telegram and Slack" },
      { value: "none", label: "None for now", hint: "Configure later" },
    ],
  });

  // --- Step 3: Channel tokens + connection test ---
  let telegramBotToken: string | undefined;
  let telegramBotUsername: string | undefined;
  let slackBotToken: string | undefined;
  let slackAppToken: string | undefined;
  let slackBotName: string | undefined;

  const useTelegram = channelChoice === "telegram" || channelChoice === "both";
  const useSlack = channelChoice === "slack" || channelChoice === "both";

  if (useTelegram) {
    await prompter.note(
      "Create a bot with @BotFather on Telegram to get your bot token.\n" +
        "https://core.telegram.org/bots/tutorial#obtain-your-bot-token",
      "Telegram Setup",
    );

    telegramBotToken = await prompter.text({
      message: "Telegram bot token:",
      placeholder: "123456:ABC-DEF...",
      validate: validateToken,
    });

    const tgProgress = prompter.progress("Testing Telegram connection...");
    const tgResult = await testTelegramToken(telegramBotToken);
    if (tgResult.ok) {
      telegramBotUsername = tgResult.username;
      tgProgress.stop(`Connected to @${tgResult.username}`);
    } else {
      tgProgress.stop(`Connection failed: ${tgResult.error}`);
      await prompter.note(
        "The token didn't work, but it's saved to config.\n" +
          "You can update it later in: " +
          paths.config,
        "Warning",
      );
    }
  }

  if (useSlack) {
    await prompter.note(
      "Create a Slack app at https://api.slack.com/apps\n" +
        "Enable Socket Mode and add the bot/app tokens.\n\n" +
        "Required scopes: app_mentions:read, chat:write, channels:history",
      "Slack Setup",
    );

    slackBotToken = await prompter.text({
      message: "Slack bot token (xoxb-...):",
      placeholder: "xoxb-...",
      validate: validateToken,
    });

    slackAppToken = await prompter.text({
      message: "Slack app-level token (xapp-...):",
      placeholder: "xapp-...",
      validate: validateToken,
    });

    const slackProgress = prompter.progress("Testing Slack connection...");
    const slackResult = await testSlackToken(slackBotToken);
    if (slackResult.ok) {
      slackBotName = slackResult.botName;
      slackProgress.stop(`Connected as ${slackResult.botName}`);
    } else {
      slackProgress.stop(`Connection failed: ${slackResult.error}`);
      await prompter.note(
        "The token didn't work, but it's saved to config.\n" +
          "You can update it later in: " +
          paths.config,
        "Warning",
      );
    }
  }

  // --- Step 4: Memory provider ---
  const memoryProvider = await prompter.select<MemoryProvider>({
    message: "Memory search provider (embeddings for semantic search):",
    options: [
      {
        value: "none",
        label: "Text search only (FTS5)",
        hint: "No API key needed, works offline",
      },
      {
        value: "openai",
        label: "OpenAI",
        hint: "Requires OPENAI_API_KEY env var",
      },
      {
        value: "ollama",
        label: "Ollama (local)",
        hint: "Free, runs locally",
      },
      { value: "gemini", label: "Google Gemini", hint: "Requires GEMINI_API_KEY" },
      { value: "voyage", label: "Voyage AI", hint: "Requires VOYAGE_API_KEY" },
      { value: "mistral", label: "Mistral", hint: "Requires MISTRAL_API_KEY" },
    ],
    initialValue: "none",
  });

  // --- Step 5: Write config ---
  const configProgress = prompter.progress("Writing configuration...");

  const config = buildConfig({
    channelChoice,
    telegramBotToken,
    slackBotToken,
    slackAppToken,
    memoryProvider,
  });

  // Ensure directories exist
  for (const dir of [
    dirname(paths.config),
    paths.logs,
    paths.sessions,
    paths.memory,
    paths.cron,
    paths.skills,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(paths.config, JSON.stringify(config, null, 2) + "\n");
  configProgress.stop(`Config written to ${paths.config}`);

  // --- Step 6: Summary + offer to start ---
  const summaryLines: string[] = [];
  if (telegramBotUsername) {
    summaryLines.push(`Telegram: @${telegramBotUsername}`);
  } else if (useTelegram) {
    summaryLines.push("Telegram: configured (connection not verified)");
  }
  if (slackBotName) {
    summaryLines.push(`Slack: ${slackBotName}`);
  } else if (useSlack) {
    summaryLines.push("Slack: configured (connection not verified)");
  }
  if (!useTelegram && !useSlack) {
    summaryLines.push("No channels configured yet");
  }
  summaryLines.push(`Memory: ${memoryProvider === "none" ? "text search (FTS5)" : memoryProvider}`);
  summaryLines.push(`Config: ${paths.config}`);

  await prompter.note(summaryLines.join("\n"), "Setup Complete");

  const startNow = await prompter.confirm({
    message: "Start the OpenClaude gateway now?",
    initialValue: true,
  });

  if (startNow) {
    await prompter.outro("Starting gateway... Run `openclaude status` to check.");
  } else {
    await prompter.outro(
      "Run `openclaude start` when you're ready to launch the gateway.",
    );
  }

  return {
    configPath: paths.config,
    channels: channelChoice,
    memoryProvider,
  };
}

// --- Config builder ---

function buildConfig(params: {
  channelChoice: ChannelChoice;
  telegramBotToken?: string;
  slackBotToken?: string;
  slackAppToken?: string;
  memoryProvider: MemoryProvider;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    channels: {},
    agent: { maxConcurrent: 4, defaultTimeout: 300_000 },
    heartbeat: { enabled: false, every: 1_800_000 },
    mcp: {},
    memory: {
      enabled: true,
      sources: ["memory"],
      provider: params.memoryProvider,
      store: {
        driver: "sqlite",
        vector: { enabled: params.memoryProvider !== "none" },
      },
    },
    cron: { enabled: false },
    gateway: { port: 45557, auth: { mode: "none" } },
  };

  const channels: Record<string, unknown> = {};

  if (
    params.channelChoice === "telegram" ||
    params.channelChoice === "both"
  ) {
    channels.telegram = {
      enabled: true,
      botToken: params.telegramBotToken,
      mode: "polling",
    };
  }

  if (params.channelChoice === "slack" || params.channelChoice === "both") {
    channels.slack = {
      enabled: true,
      botToken: params.slackBotToken,
      appToken: params.slackAppToken,
      mode: "socket",
    };
  }

  config.channels = channels;
  return config;
}
