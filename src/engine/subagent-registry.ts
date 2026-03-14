/**
 * Subagent run registry — tracks parent-child session relationships.
 * Adapted from OpenClaw's subagent-registry.types.ts and subagent-registry-queries.ts.
 * Simplified for depth-1 only (no nesting).
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import type { TokenUsage } from "./types.js";

export const MAX_RESULT_BYTES = 100_000; // 100KB

export interface SubagentRun {
  runId: string;
  parentSessionKey: string;
  parentSessionId: string;
  childSessionId: string;
  childClaudeSessionId?: string;
  task: string;
  label?: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "killed";
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  result?: string;
  error?: string;
  usage?: TokenUsage;
  duration?: number;
  announced?: boolean;
  timeoutSeconds?: number;
}

export function createSubagentRegistry(persistPath: string) {
  const runs = new Map<string, SubagentRun>();

  if (existsSync(persistPath)) {
    try {
      const data = JSON.parse(readFileSync(persistPath, "utf-8")) as SubagentRun[];
      for (const run of data) {
        runs.set(run.runId, run);
      }
    } catch {
      // Corrupted file, start fresh
    }
  }

  function persist(): void {
    writeFileSync(persistPath, JSON.stringify([...runs.values()], null, 2), "utf-8");
  }

  function register(run: SubagentRun): void {
    runs.set(run.runId, run);
    persist();
  }

  function get(runId: string): SubagentRun | undefined {
    return runs.get(runId);
  }

  function getRunsForParent(parentSessionId: string): SubagentRun[] {
    return [...runs.values()].filter((r) => r.parentSessionId === parentSessionId);
  }

  function getActiveRunsForParent(parentSessionId: string): SubagentRun[] {
    return [...runs.values()].filter(
      (r) => r.parentSessionId === parentSessionId && (r.status === "running" || r.status === "queued"),
    );
  }

  function getUnannounced(parentSessionId: string): SubagentRun[] {
    return [...runs.values()].filter(
      (r) =>
        r.parentSessionId === parentSessionId &&
        r.status !== "running" &&
        r.status !== "queued" &&
        !r.announced,
    );
  }

  function markAnnounced(runId: string): void {
    const run = runs.get(runId);
    if (run) {
      run.announced = true;
      persist();
    }
  }

  function endRun(runId: string, status: SubagentRun["status"], result?: string, error?: string): void {
    const run = runs.get(runId);
    if (!run) return;
    run.status = status;
    run.endedAt = Date.now();
    run.duration = run.endedAt - run.createdAt;
    if (error) run.error = error;
    if (result != null) {
      if (Buffer.byteLength(result, "utf-8") > MAX_RESULT_BYTES) {
        run.result =
          result.slice(0, MAX_RESULT_BYTES) +
          "\n\n(truncated — full result available via sessions_status)";
      } else {
        run.result = result;
      }
    }
    persist();
  }

  function reconcileOrphans(isAlive: (sessionId: string) => boolean): void {
    for (const run of runs.values()) {
      if ((run.status === "running" || run.status === "queued") && !isAlive(run.childSessionId)) {
        run.status = "failed";
        run.endedAt = Date.now();
        run.error = "gateway restarted — process lost";
        run.duration = run.endedAt - run.createdAt;
      }
    }
    persist();
  }

  function allRuns(): SubagentRun[] {
    return [...runs.values()];
  }

  return { register, get, getRunsForParent, getActiveRunsForParent, getUnannounced, markAnnounced, endRun, reconcileOrphans, allRuns };
}

export type SubagentRegistry = ReturnType<typeof createSubagentRegistry>;
