import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";
import {
  isHeartbeatOk,
  isHeartbeatContentEffectivelyEmpty,
  isWithinActiveHours,
  stripHeartbeatToken,
  resolveHeartbeatPrompt,
  createHeartbeatRunner,
  resolveHeartbeatAgents,
  HEARTBEAT_TOKEN,
  HEARTBEAT_PROMPT,
  DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  type HeartbeatConfig,
  type HeartbeatDeps,
} from "./heartbeat.js";
import { resetHeartbeatWakeStateForTests } from "./heartbeat-wake.js";

// ── HEARTBEAT_OK token detection ──

describe("stripHeartbeatToken", () => {
  it("skips bare HEARTBEAT_OK", () => {
    const r = stripHeartbeatToken("HEARTBEAT_OK");
    expect(r.shouldSkip).toBe(true);
    expect(r.didStrip).toBe(true);
  });

  it("skips HEARTBEAT_OK with trailing punctuation", () => {
    expect(stripHeartbeatToken("HEARTBEAT_OK.").shouldSkip).toBe(true);
    expect(stripHeartbeatToken("HEARTBEAT_OK!").shouldSkip).toBe(true);
    expect(stripHeartbeatToken("HEARTBEAT_OK!!").shouldSkip).toBe(true);
  });

  it("skips HEARTBEAT_OK wrapped in markdown", () => {
    expect(stripHeartbeatToken("**HEARTBEAT_OK**").shouldSkip).toBe(true);
    expect(stripHeartbeatToken("`HEARTBEAT_OK`").shouldSkip).toBe(true);
  });

  it("skips HEARTBEAT_OK wrapped in HTML", () => {
    expect(stripHeartbeatToken("<b>HEARTBEAT_OK</b>").shouldSkip).toBe(true);
  });

  it("skips short ack text after stripping token", () => {
    const r = stripHeartbeatToken("HEARTBEAT_OK All clear.", { maxAckChars: 300 });
    expect(r.shouldSkip).toBe(true);
  });

  it("keeps long text after stripping token", () => {
    const longText = "HEARTBEAT_OK " + "x".repeat(400);
    const r = stripHeartbeatToken(longText, { maxAckChars: 300 });
    expect(r.shouldSkip).toBe(false);
    expect(r.text.length).toBeGreaterThan(300);
  });

  it("does not skip text without token", () => {
    const r = stripHeartbeatToken("Disk usage is at 95%");
    expect(r.shouldSkip).toBe(false);
    expect(r.text).toBe("Disk usage is at 95%");
  });

  it("handles empty/undefined input", () => {
    expect(stripHeartbeatToken(undefined).shouldSkip).toBe(true);
    expect(stripHeartbeatToken("").shouldSkip).toBe(true);
    expect(stripHeartbeatToken("   ").shouldSkip).toBe(true);
  });
});

describe("isHeartbeatOk", () => {
  it("recognizes HEARTBEAT_OK token variants", () => {
    expect(isHeartbeatOk("HEARTBEAT_OK")).toBe(true);
    expect(isHeartbeatOk("  HEARTBEAT_OK  ")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_OK.")).toBe(true);
    expect(isHeartbeatOk("**HEARTBEAT_OK**")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT_OK All good, nothing to report.")).toBe(true);
  });

  it("recognizes legacy heartbeat-ok variants", () => {
    // These are no longer detected by isHeartbeatOk since we switched to HEARTBEAT_OK token.
    // Legacy "heartbeat ok" / "all good" are NOT the token and should not be treated as ok.
    expect(isHeartbeatOk("heartbeat ok")).toBe(false);
    expect(isHeartbeatOk("all good")).toBe(false);
  });

  it("rejects non-trivial responses", () => {
    expect(isHeartbeatOk("disk usage is at 95%")).toBe(false);
    expect(isHeartbeatOk("error found in logs")).toBe(false);
    // Empty string is treated as "nothing to report" (shouldSkip=true)
    expect(isHeartbeatOk("")).toBe(true);
  });
});

// ── Content emptiness check ──

describe("isHeartbeatContentEffectivelyEmpty", () => {
  it("returns true for empty/whitespace content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("   \n  ")).toBe(true);
  });

  it("returns true for headers-only content", () => {
    expect(isHeartbeatContentEffectivelyEmpty("# Heartbeat\n## Tasks")).toBe(true);
  });

  it("returns true for empty list items", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- [ ]\n- [ ]")).toBe(true);
    expect(isHeartbeatContentEffectivelyEmpty("* [ ]\n- ")).toBe(true);
  });

  it("returns false for content with actionable items", () => {
    expect(isHeartbeatContentEffectivelyEmpty("- [ ] Check disk")).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty("# Tasks\n- [x] Done\nCheck logs")).toBe(false);
  });

  it("returns false for null/undefined", () => {
    expect(isHeartbeatContentEffectivelyEmpty(null)).toBe(false);
    expect(isHeartbeatContentEffectivelyEmpty(undefined)).toBe(false);
  });
});

// ── Active hours ──

describe("isWithinActiveHours", () => {
  it("returns true when no active hours configured", () => {
    expect(isWithinActiveHours(undefined)).toBe(true);
  });

  it("returns true when within normal range", () => {
    // Use a fixed time: 2026-03-14T14:30:00Z (14:30 UTC)
    const nowMs = new Date("2026-03-14T14:30:00Z").getTime();
    expect(isWithinActiveHours({ start: "09:00", end: "17:00", timezone: "UTC" }, nowMs)).toBe(true);
  });

  it("returns false when outside normal range", () => {
    // 03:30 UTC is outside 09:00–17:00
    const nowMs = new Date("2026-03-14T03:30:00Z").getTime();
    expect(isWithinActiveHours({ start: "09:00", end: "17:00", timezone: "UTC" }, nowMs)).toBe(false);
  });

  it("handles midnight-wrapping ranges", () => {
    // 23:30 UTC should be within 22:00–06:00
    const nowMs = new Date("2026-03-14T23:30:00Z").getTime();
    expect(isWithinActiveHours({ start: "22:00", end: "06:00", timezone: "UTC" }, nowMs)).toBe(true);

    // 12:00 UTC should be outside 22:00–06:00
    const noonMs = new Date("2026-03-14T12:00:00Z").getTime();
    expect(isWithinActiveHours({ start: "22:00", end: "06:00", timezone: "UTC" }, noonMs)).toBe(false);
  });

  it("returns false when start equals end (blocked all day)", () => {
    const nowMs = new Date("2026-03-14T12:00:00Z").getTime();
    expect(isWithinActiveHours({ start: "09:00", end: "09:00", timezone: "UTC" }, nowMs)).toBe(false);
  });

  it("returns true for invalid time format (permissive)", () => {
    expect(isWithinActiveHours({ start: "bad", end: "bad" })).toBe(true);
  });
});

// ── Prompt resolution ──

describe("resolveHeartbeatPrompt", () => {
  it("returns default prompt when no custom prompt", () => {
    expect(resolveHeartbeatPrompt()).toBe(HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt("")).toBe(HEARTBEAT_PROMPT);
    expect(resolveHeartbeatPrompt("   ")).toBe(HEARTBEAT_PROMPT);
  });

  it("returns custom prompt when provided", () => {
    expect(resolveHeartbeatPrompt("Check the servers")).toBe("Check the servers");
  });
});

// ── Runner ──

describe("createHeartbeatRunner", () => {
  let tempDir: string;
  let checklistPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "heartbeat-test-"));
    checklistPath = join(tempDir, "HEARTBEAT.md");
  });

  afterEach(() => {
    resetHeartbeatWakeStateForTests();
    rmSync(tempDir, { recursive: true, force: true });
  });

  function makeConfig(overrides?: Partial<HeartbeatConfig>): HeartbeatConfig {
    return {
      enabled: true,
      every: 60_000,
      checklistPath,
      ...overrides,
    };
  }

  function makeDeps(overrides?: Partial<HeartbeatDeps>): HeartbeatDeps {
    return {
      runIsolated: async () => ({ status: "ok" as const, summary: HEARTBEAT_TOKEN }),
      ...overrides,
    };
  }

  it("runs with missing checklist file (not an error)", async () => {
    // Missing file should still run — the prompt says "if it exists"
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());
    const result = await runner.runOnce();
    expect(result.status).toBe("ok");
  });

  it("skips when checklist file is effectively empty", async () => {
    writeFileSync(checklistPath, "# Tasks\n- [ ]\n");
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());
    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/empty/i);
  });

  it("uses configured prompt", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk space");

    let capturedPrompt = "";
    const deps = makeDeps({
      runIsolated: async (prompt: string) => {
        capturedPrompt = prompt;
        return { status: "ok" as const, summary: HEARTBEAT_TOKEN };
      },
    });

    const runner = createHeartbeatRunner(
      makeConfig({ prompt: "Custom heartbeat prompt" }),
      deps,
    );
    await runner.runOnce();

    expect(capturedPrompt).toContain("Custom heartbeat prompt");
    expect(capturedPrompt).toContain("Check disk space");
  });

  it("uses default prompt when none configured", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk space");

    let capturedPrompt = "";
    const deps = makeDeps({
      runIsolated: async (prompt: string) => {
        capturedPrompt = prompt;
        return { status: "ok" as const, summary: HEARTBEAT_TOKEN };
      },
    });

    const runner = createHeartbeatRunner(makeConfig(), deps);
    await runner.runOnce();

    expect(capturedPrompt).toContain(HEARTBEAT_PROMPT);
    expect(capturedPrompt).toContain("Check disk space");
  });

  it("delivers non-trivial results to target", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const delivered: Array<{ target: CronDeliveryTarget; text: string }> = [];

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: "Disk usage at 95%, action needed",
      }),
      deliver: async (t, text) => {
        delivered.push({ target: t, text });
      },
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);
    await runner.runOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0].target).toEqual(target);
    expect(delivered[0].text).toBe("Disk usage at 95%, action needed");
  });

  it("does not deliver HEARTBEAT_OK responses", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "slack", chatId: "C01" };
    let deliverCalled = false;

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: HEARTBEAT_TOKEN,
      }),
      deliver: async () => {
        deliverCalled = true;
      },
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);
    await runner.runOnce();

    expect(deliverCalled).toBe(false);
  });

  it("strips HEARTBEAT_OK prefix from delivery text", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const delivered: string[] = [];
    const longAlert = "x".repeat(400);

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: `HEARTBEAT_OK ${longAlert}`,
      }),
      deliver: async (_t, text) => {
        delivered.push(text);
      },
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);
    await runner.runOnce();

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).not.toContain("HEARTBEAT_OK");
  });

  it("suppresses duplicate messages within 24h", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const delivered: string[] = [];
    let nowMs = Date.now();

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: "Disk usage at 95%",
      }),
      deliver: async (_t, text) => {
        delivered.push(text);
      },
      nowMs: () => nowMs,
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);

    await runner.runOnce();
    expect(delivered).toHaveLength(1);

    // Same message 1h later → suppressed
    nowMs += 3_600_000;
    await runner.runOnce();
    expect(delivered).toHaveLength(1);

    // Same message 25h later → delivered again
    nowMs += 24 * 3_600_000;
    await runner.runOnce();
    expect(delivered).toHaveLength(2);
  });

  it("does not suppress different messages", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "telegram", chatId: "123" };
    const delivered: string[] = [];
    let callCount = 0;

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: `Alert ${++callCount}`,
      }),
      deliver: async (_t, text) => {
        delivered.push(text);
      },
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);

    await runner.runOnce();
    await runner.runOnce();
    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toBe("Alert 1");
    expect(delivered[1]).toBe("Alert 2");
  });

  it("skips during quiet hours", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const runner = createHeartbeatRunner(
      makeConfig({
        activeHours: { start: "09:00", end: "17:00", timezone: "UTC" },
      }),
      makeDeps({
        // 03:30 UTC is outside 09:00–17:00
        nowMs: () => new Date("2026-03-14T03:30:00Z").getTime(),
      }),
    );

    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/active hours/i);
  });

  it("prevents concurrent execution", async () => {
    writeFileSync(checklistPath, "- [ ] Check something");

    let concurrency = 0;
    let maxConcurrency = 0;

    const deps = makeDeps({
      runIsolated: async () => {
        concurrency++;
        if (concurrency > maxConcurrency) maxConcurrency = concurrency;
        await new Promise((resolve) => setTimeout(resolve, 50));
        concurrency--;
        return { status: "ok" as const, summary: HEARTBEAT_TOKEN };
      },
    });

    const runner = createHeartbeatRunner(makeConfig(), deps);

    const [r1, r2] = await Promise.all([runner.runOnce(), runner.runOnce()]);

    expect(maxConcurrency).toBe(1);

    const statuses = [r1.status, r2.status];
    expect(statuses).toContain("ok");
    expect(statuses).toContain("skipped");
  });

  it("start and stop control the running state", () => {
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());

    expect(runner.isRunning()).toBe(false);
    runner.start();
    expect(runner.isRunning()).toBe(true);
    runner.stop();
    expect(runner.isRunning()).toBe(false);
  });

  // ── Multi-agent tests ──

  it("resolveHeartbeatAgents produces single default agent when no agents configured", () => {
    const agents = resolveHeartbeatAgents(makeConfig());
    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe("default");
    expect(agents[0].intervalMs).toBe(60_000);
  });

  it("resolveHeartbeatAgents merges agent configs with top-level defaults", () => {
    const agents = resolveHeartbeatAgents(
      makeConfig({
        prompt: "top-level prompt",
        ackMaxChars: 200,
        agents: [
          { id: "ops", every: 30_000 },
          { id: "monitor", prompt: "monitor prompt" },
        ],
      }),
    );
    expect(agents).toHaveLength(2);

    expect(agents[0].agentId).toBe("ops");
    expect(agents[0].intervalMs).toBe(30_000);
    expect(agents[0].config.prompt).toBe("top-level prompt");
    expect(agents[0].config.ackMaxChars).toBe(200);

    expect(agents[1].agentId).toBe("monitor");
    expect(agents[1].intervalMs).toBe(60_000);
    expect(agents[1].config.prompt).toBe("monitor prompt");
  });

  it("runs specific agent by ID", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    let capturedPrompt = "";
    const deps = makeDeps({
      runIsolated: async (prompt: string) => {
        capturedPrompt = prompt;
        return { status: "ok" as const, summary: HEARTBEAT_TOKEN };
      },
    });

    const runner = createHeartbeatRunner(
      makeConfig({
        agents: [
          { id: "ops", prompt: "Ops agent prompt" },
          { id: "monitor", prompt: "Monitor agent prompt" },
        ],
      }),
      deps,
    );

    await runner.runOnce("monitor");
    expect(capturedPrompt).toContain("Monitor agent prompt");
  });

  it("updateConfig preserves lastRunMs for surviving agents", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const runner = createHeartbeatRunner(
      makeConfig({
        agents: [
          { id: "ops", every: 30_000 },
          { id: "monitor", every: 60_000 },
        ],
      }),
      makeDeps(),
    );
    runner.start();

    // Run ops agent to set its lastRunMs
    await runner.runOnce("ops");

    // Update config — ops survives, monitor is replaced by new-monitor
    runner.updateConfig(
      makeConfig({
        agents: [
          { id: "ops", every: 45_000 },
          { id: "new-monitor", every: 120_000 },
        ],
      }),
    );

    // Ops agent should keep its lastRunMs
    const result = await runner.runOnce("ops");
    expect(result.status).toBe("ok");

    // new-monitor should exist
    const result2 = await runner.runOnce("new-monitor");
    expect(result2.status).toBe("ok");

    runner.stop();
  });

  it("returns error for unknown agent ID", async () => {
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());
    const result = await runner.runOnce("nonexistent");
    expect(result.status).toBe("skipped");
    expect(result.error).toContain("Unknown agent");
  });
});
