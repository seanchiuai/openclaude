#!/usr/bin/env npx tsx

/**
 * Fake Claude CLI binary for integration testing.
 *
 * Mimics the real `claude -p --output-format stream-json` NDJSON output,
 * controlled via environment variables:
 *
 *   FAKE_CLAUDE_RESPONSE   — response text (default: "Hello from fake claude")
 *   FAKE_CLAUDE_DELAY_MS   — delay before responding in ms (default: 10)
 *   FAKE_CLAUDE_EXIT_CODE  — process exit code (default: 0)
 *   FAKE_CLAUDE_CRASH      — if "true", crash immediately with exit 1
 *   FAKE_CLAUDE_HANG       — if "true", never exit (for timeout testing)
 *   FAKE_CLAUDE_EVENTS     — path to NDJSON file to replay instead of defaults
 */

import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

// --- Crash mode: bail immediately ---
if (process.env.FAKE_CLAUDE_CRASH === "true") {
  process.stderr.write("fake-claude: simulated crash\n");
  process.exit(1);
}

// --- Hang mode: keep process alive forever ---
if (process.env.FAKE_CLAUDE_HANG === "true") {
  // Drain stdin so the parent doesn't get EPIPE, then idle.
  process.stdin.resume();
  setInterval(() => {}, 1 << 30);
  // Never exits — caller must kill/timeout.
} else {
  run();
}

async function run(): Promise<void> {
  // Drain stdin (the prompt) — we don't use it, but the pipe must be consumed.
  await new Promise<void>((resolve) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", resolve);
    process.stdin.on("error", resolve);
  });

  const delayMs = Number(process.env.FAKE_CLAUDE_DELAY_MS ?? "10");
  if (delayMs > 0) {
    await new Promise<void>((r) => setTimeout(r, delayMs));
  }

  const exitCode = Number(process.env.FAKE_CLAUDE_EXIT_CODE ?? "0");

  // If a custom events file is specified, replay it verbatim.
  const eventsPath = process.env.FAKE_CLAUDE_EVENTS;
  if (eventsPath) {
    const raw = readFileSync(eventsPath, "utf-8");
    process.stdout.write(raw);
    process.exit(exitCode);
  }

  // Default event sequence
  const response = process.env.FAKE_CLAUDE_RESPONSE ?? "Hello from fake claude";
  const sessionId = randomUUID();
  const messageId = randomUUID();

  const events = [
    {
      type: "system",
      subtype: "init",
      session_id: sessionId,
    },
    {
      type: "assistant",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: response }],
        model: "claude-sonnet-4-6",
      },
    },
    {
      type: "result",
      subtype: "success",
      result: response,
      session_id: sessionId,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      num_turns: 1,
      cost_usd: 0.001,
    },
  ];

  for (const event of events) {
    process.stdout.write(JSON.stringify(event) + "\n");
  }

  process.exit(exitCode);
}
