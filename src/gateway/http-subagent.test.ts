import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createGatewayApp } from "./http.js";
import type { GatewayContext } from "./http.js";
import { createSubagentRegistry } from "../engine/subagent-registry.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function createMockPool() {
  return {
    stats: vi.fn().mockReturnValue({ running: 0, queued: 0, maxConcurrent: 4 }),
    listSessions: vi.fn().mockReturnValue([]),
    submit: vi.fn(),
    drain: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getCompletion: vi.fn(),
  };
}

describe("Subagent HTTP API", () => {
  let dir: string;
  let registry: ReturnType<typeof createSubagentRegistry>;
  let app: ReturnType<typeof createGatewayApp>;
  let onSubagentSpawn: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "http-sub-"));
    registry = createSubagentRegistry(join(dir, "runs.json"));
    onSubagentSpawn = vi.fn();
    const ctx: GatewayContext = {
      pool: createMockPool() as unknown as GatewayContext["pool"],
      startedAt: Date.now(),
      channels: [],
      subagentRegistry: registry,
      onSubagentSpawn,
    };
    app = createGatewayApp(ctx);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe("POST /api/subagent/spawn", () => {
    it("returns 400 if task is missing", async () => {
      const res = await app.request("/api/subagent/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });

    it("rejects spawn from child session (sub- prefix)", async () => {
      const res = await app.request("/api/subagent/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "test", callerSessionId: "sub-xyz" }),
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error).toContain("Child sessions");
    });

    it("rejects when maxChildrenPerParent exceeded", async () => {
      // Register 4 active runs
      for (let i = 0; i < 4; i++) {
        registry.register({
          runId: `r${i}`,
          parentSessionKey: "",
          parentSessionId: "main-abc",
          childSessionId: `sub-${i}`,
          task: "task",
          status: "running",
          createdAt: Date.now(),
        });
      }

      const res = await app.request("/api/subagent/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "test", callerSessionId: "main-abc" }),
      });
      expect(res.status).toBe(429);
    });

    it("returns accepted with runId on success", async () => {
      const res = await app.request("/api/subagent/spawn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: "research AI", callerSessionId: "main-abc" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.runId).toBeDefined();
      expect(body.childSessionId).toMatch(/^sub-/);
      expect(body.status).toBe("accepted");
      expect(onSubagentSpawn).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/subagent/status", () => {
    it("returns runs for the calling parent", async () => {
      registry.register({
        runId: "r1",
        parentSessionKey: "",
        parentSessionId: "main-abc",
        childSessionId: "sub-a",
        task: "research",
        label: "research",
        status: "running",
        createdAt: Date.now(),
      });

      const res = await app.request("/api/subagent/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ callerSessionId: "main-abc" }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ok).toBe(true);
      expect(body.runs).toHaveLength(1);
      expect(body.runs[0].task).toBe("research");
    });
  });
});
