import { describe, it, expect, vi } from "vitest";
import { formatAnnounceMessage, createAnnouncePipeline } from "./subagent-announce.js";
import type { SubagentRun } from "./subagent-registry.js";

function makeCompletedRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    runId: "run-abc",
    parentSessionKey: "telegram:123",
    parentSessionId: "main-abc",
    childSessionId: "sub-xyz",
    task: "research topic X",
    label: "research",
    status: "completed",
    createdAt: Date.now() - 60_000,
    endedAt: Date.now(),
    duration: 60_000,
    result: "Found 3 relevant papers.",
    usage: { inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheCreationTokens: 0, totalCostUsd: 0.01 },
    ...overrides,
  };
}

describe("formatAnnounceMessage", () => {
  it("includes untrusted content fencing with nonce", () => {
    const msg = formatAnnounceMessage([makeCompletedRun()]);
    expect(msg).toContain("<<<BEGIN_UNTRUSTED_CHILD_RESULT_");
    expect(msg).toContain("<<<END_UNTRUSTED_CHILD_RESULT_");
    expect(msg).toContain("Found 3 relevant papers.");
  });

  it("uses randomized nonce that matches begin/end", () => {
    const msg = formatAnnounceMessage([makeCompletedRun()]);
    const beginMatch = msg.match(/<<<BEGIN_UNTRUSTED_CHILD_RESULT_([a-f0-9]+)>>>/);
    const endMatch = msg.match(/<<<END_UNTRUSTED_CHILD_RESULT_([a-f0-9]+)>>>/);
    expect(beginMatch).toBeTruthy();
    expect(endMatch).toBeTruthy();
    expect(beginMatch![1]).toBe(endMatch![1]);
  });

  it("includes metadata fields", () => {
    const msg = formatAnnounceMessage([makeCompletedRun()]);
    expect(msg).toContain("source: subagent");
    expect(msg).toContain("run_id: run-abc");
    expect(msg).toContain("task: research");
    expect(msg).toContain("status: completed successfully");
  });

  it("handles failed runs", () => {
    const msg = formatAnnounceMessage([makeCompletedRun({ status: "failed", error: "timeout exceeded" })]);
    expect(msg).toContain("status: failed: timeout exceeded");
  });

  it("handles empty result", () => {
    const msg = formatAnnounceMessage([makeCompletedRun({ result: undefined })]);
    expect(msg).toContain("(no output)");
  });

  it("concatenates multiple results with separators", () => {
    const r1 = makeCompletedRun({ runId: "run-1", label: "task1" });
    const r2 = makeCompletedRun({ runId: "run-2", label: "task2" });
    const msg = formatAnnounceMessage([r1, r2]);
    expect(msg).toContain("task: task1");
    expect(msg).toContain("task: task2");
    expect(msg.split("---").length).toBeGreaterThanOrEqual(2);
  });

  it("includes runtime stats", () => {
    const msg = formatAnnounceMessage([makeCompletedRun()]);
    expect(msg).toMatch(/Stats: runtime \d+[sm]/);
  });
});

describe("createAnnouncePipeline", () => {
  it("debounces multiple completions within 2s window", async () => {
    const resumeParent = vi.fn().mockResolvedValue(undefined);
    const pipeline = createAnnouncePipeline({ resumeParent, debounceMs: 50 }); // fast for tests

    pipeline.enqueue(makeCompletedRun({ runId: "r1" }));
    pipeline.enqueue(makeCompletedRun({ runId: "r2" }));

    await vi.waitFor(() => expect(resumeParent).toHaveBeenCalledTimes(1));
    // Both runs delivered in single call
    expect(resumeParent.mock.calls[0][1]).toHaveLength(2);
  });

  it("delivers separately when outside debounce window", async () => {
    const resumeParent = vi.fn().mockResolvedValue(undefined);
    const pipeline = createAnnouncePipeline({ resumeParent, debounceMs: 20 });

    pipeline.enqueue(makeCompletedRun({ runId: "r1", parentSessionId: "main-a" }));
    await new Promise((r) => setTimeout(r, 50)); // wait past debounce
    pipeline.enqueue(makeCompletedRun({ runId: "r2", parentSessionId: "main-a" }));

    await vi.waitFor(() => expect(resumeParent).toHaveBeenCalledTimes(2));
  });

  it("retries on resume failure with backoff", async () => {
    let calls = 0;
    const resumeParent = vi.fn().mockImplementation(async () => {
      calls++;
      if (calls <= 2) throw new Error("resume failed");
    });
    const pipeline = createAnnouncePipeline({ resumeParent, debounceMs: 10, retryDelays: [10, 20] });

    pipeline.enqueue(makeCompletedRun());

    await vi.waitFor(() => expect(resumeParent).toHaveBeenCalledTimes(3), { timeout: 2000 });
  });
});
