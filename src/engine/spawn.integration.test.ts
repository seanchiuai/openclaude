import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnClaude } from "./spawn.js";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const FAKE_CLAUDE = join(__dirname, "../../test/fixtures/fake-claude.ts");
const FAKE_CLAUDE_CMD = `npx tsx ${FAKE_CLAUDE}`;

describe("engine spawn integration", () => {
  let sessionDir: string;

  beforeEach(async () => {
    sessionDir = await mkdtemp(join(tmpdir(), "openclaude-spawn-test-"));
  });
  afterEach(async () => {
    await rm(sessionDir, { recursive: true, force: true });
  });

  it("spawns fake-claude and parses NDJSON result", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "spawn-test-1",
        prompt: "What is 2+2?",
        workingDirectory: sessionDir,
      },
      undefined,
      { claudeBinary: FAKE_CLAUDE_CMD },
    );

    const result = await promise;
    expect(result.text).toBe("Hello from fake claude");
    expect(result.exitCode).toBe(0);
    expect(result.claudeSessionId).toBeDefined();
    expect(result.usage).toBeDefined();
    expect(result.usage!.inputTokens).toBe(100);
    expect(result.usage!.outputTokens).toBe(50);
  });

  it("handles subprocess crash gracefully", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "crash-test",
        prompt: "crash",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: FAKE_CLAUDE_CMD,
        env: { FAKE_CLAUDE_CRASH: "true" },
      },
    );

    const result = await promise;
    expect(result.exitCode).not.toBe(0);
  });

  it("custom response via env var", async () => {
    const { promise } = spawnClaude(
      {
        sessionId: "custom-test",
        prompt: "test",
        workingDirectory: sessionDir,
      },
      undefined,
      {
        claudeBinary: FAKE_CLAUDE_CMD,
        env: { FAKE_CLAUDE_RESPONSE: "custom answer" },
      },
    );

    const result = await promise;
    expect(result.text).toBe("custom answer");
  });

  it("streams text events to callback", async () => {
    const events: Array<{ type: string }> = [];
    const { promise } = spawnClaude(
      {
        sessionId: "events-test",
        prompt: "test",
        workingDirectory: sessionDir,
      },
      (event) => events.push(event),
      { claudeBinary: FAKE_CLAUDE_CMD },
    );

    await promise;
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
  });
});
