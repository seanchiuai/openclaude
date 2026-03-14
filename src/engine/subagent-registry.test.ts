import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createSubagentRegistry } from "./subagent-registry.js";
import type { SubagentRun } from "./subagent-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    runId: `run-${Math.random().toString(36).slice(2, 8)}`,
    parentSessionKey: "telegram:123",
    parentSessionId: "main-abc",
    childSessionId: `sub-${Math.random().toString(36).slice(2, 8)}`,
    task: "test task",
    status: "running",
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("SubagentRegistry", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "reg-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("registers and retrieves a run", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const run = makeRun();
    reg.register(run);
    expect(reg.get(run.runId)).toEqual(run);
  });

  it("lists runs for a parent", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const r1 = makeRun({ parentSessionId: "main-abc" });
    const r2 = makeRun({ parentSessionId: "main-abc" });
    const r3 = makeRun({ parentSessionId: "main-other" });
    reg.register(r1);
    reg.register(r2);
    reg.register(r3);
    expect(reg.getRunsForParent("main-abc")).toHaveLength(2);
  });

  it("returns only active (running/queued) runs", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const r1 = makeRun({ status: "running" });
    const r2 = makeRun({ status: "completed", endedAt: Date.now() });
    reg.register(r1);
    reg.register(r2);
    expect(reg.getActiveRunsForParent(r1.parentSessionId)).toHaveLength(1);
  });

  it("ends a run and updates status", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const run = makeRun();
    reg.register(run);
    reg.endRun(run.runId, "completed", "result text");
    const updated = reg.get(run.runId)!;
    expect(updated.status).toBe("completed");
    expect(updated.result).toBe("result text");
    expect(updated.endedAt).toBeTypeOf("number");
  });

  it("truncates result to MAX_RESULT_BYTES", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const run = makeRun();
    reg.register(run);
    const bigResult = "x".repeat(200_000);
    reg.endRun(run.runId, "completed", bigResult);
    const updated = reg.get(run.runId)!;
    expect(updated.result!.length).toBeLessThan(200_000);
    expect(updated.result).toContain("(truncated");
  });

  it("returns unannounced runs", () => {
    const reg = createSubagentRegistry(join(dir, "runs.json"));
    const r1 = makeRun();
    const r2 = makeRun();
    reg.register(r1);
    reg.register(r2);
    reg.endRun(r1.runId, "completed", "done");
    reg.endRun(r2.runId, "completed", "done");
    reg.markAnnounced(r1.runId);
    expect(reg.getUnannounced(r1.parentSessionId)).toHaveLength(1);
  });

  it("persists to disk and restores", () => {
    const path = join(dir, "runs.json");
    const reg1 = createSubagentRegistry(path);
    const run = makeRun();
    reg1.register(run);

    const reg2 = createSubagentRegistry(path);
    expect(reg2.get(run.runId)).toBeDefined();
    expect(reg2.get(run.runId)!.task).toBe(run.task);
  });

  it("reconciles orphaned runs", () => {
    const path = join(dir, "runs.json");
    const reg = createSubagentRegistry(path);
    const run = makeRun({ status: "running" });
    reg.register(run);
    // Simulate restart: orphan has no live process
    reg.reconcileOrphans((sessionId) => false); // isAlive returns false
    expect(reg.get(run.runId)!.status).toBe("failed");
    expect(reg.get(run.runId)!.error).toContain("gateway restarted");
  });
});
