import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";
import {
  isHeartbeatOk,
  createHeartbeatRunner,
  type HeartbeatConfig,
  type HeartbeatDeps,
} from "./heartbeat.js";

describe("isHeartbeatOk", () => {
  it("recognizes valid heartbeat-ok variants", () => {
    expect(isHeartbeatOk("heartbeat ok")).toBe(true);
    expect(isHeartbeatOk("Heartbeat OK")).toBe(true);
    expect(isHeartbeatOk("heartbeat: ok")).toBe(true);
    expect(isHeartbeatOk("HEARTBEAT: OK")).toBe(true);
    expect(isHeartbeatOk("all good")).toBe(true);
    expect(isHeartbeatOk("All Good")).toBe(true);
    expect(isHeartbeatOk("  heartbeat ok  ")).toBe(true);
    expect(isHeartbeatOk("heartbeat ok - nothing to report")).toBe(true);
  });

  it("rejects non-trivial responses", () => {
    expect(isHeartbeatOk("disk usage is at 95%")).toBe(false);
    expect(isHeartbeatOk("error found in logs")).toBe(false);
    expect(isHeartbeatOk("")).toBe(false);
    expect(isHeartbeatOk("ok")).toBe(false);
    expect(isHeartbeatOk("beat ok")).toBe(false);
  });
});

describe("createHeartbeatRunner", () => {
  let tempDir: string;
  let checklistPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "heartbeat-test-"));
    checklistPath = join(tempDir, "HEARTBEAT.md");
  });

  afterEach(() => {
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
      runIsolated: async () => ({ status: "ok" as const, summary: "heartbeat ok" }),
      ...overrides,
    };
  }

  it("skips when no checklist file exists", async () => {
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());
    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/not found/i);
  });

  it("skips when checklist file is empty", async () => {
    writeFileSync(checklistPath, "   \n  ");
    const runner = createHeartbeatRunner(makeConfig(), makeDeps());
    const result = await runner.runOnce();
    expect(result.status).toBe("skipped");
    expect(result.error).toMatch(/empty/i);
  });

  it("runs agent with checklist content in prompt", async () => {
    const checklist = "- [ ] Check disk space\n- [ ] Verify backups";
    writeFileSync(checklistPath, checklist);

    let capturedPrompt = "";
    const deps = makeDeps({
      runIsolated: async (prompt: string) => {
        capturedPrompt = prompt;
        return { status: "ok" as const, summary: "heartbeat ok" };
      },
    });

    const runner = createHeartbeatRunner(makeConfig(), deps);
    await runner.runOnce();

    expect(capturedPrompt).toContain("heartbeat check");
    expect(capturedPrompt).toContain("Check disk space");
    expect(capturedPrompt).toContain("Verify backups");
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

  it("does not deliver heartbeat-ok responses", async () => {
    writeFileSync(checklistPath, "- [ ] Check disk");

    const target: CronDeliveryTarget = { channel: "slack", chatId: "C01" };
    let deliverCalled = false;

    const deps = makeDeps({
      runIsolated: async () => ({
        status: "ok" as const,
        summary: "heartbeat ok",
      }),
      deliver: async () => {
        deliverCalled = true;
      },
    });

    const runner = createHeartbeatRunner(makeConfig({ target }), deps);
    await runner.runOnce();

    expect(deliverCalled).toBe(false);
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
        return { status: "ok" as const, summary: "heartbeat ok" };
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
});
