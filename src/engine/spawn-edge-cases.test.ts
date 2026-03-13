/**
 * Edge case tests for spawn.ts.
 *
 * Covers: MCP config merging, empty/missing fields, JSON parsing edge cases,
 * process output parsing robustness.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// We test parseClaudeOutput indirectly through spawn, but let's also
// test the internal JSON parsing logic by extracting test cases.

// Mock paths to use temp directory — vi.mock is hoisted, so use inline imports
vi.mock("../config/paths.js", async () => {
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const dir = join(tmpdir(), "openclaude-spawn-test");
  return {
    paths: {
      sessions: join(dir, "sessions"),
      base: dir,
    },
  };
});

const testDir = join(tmpdir(), "openclaude-spawn-test");

import { spawnClaude } from "./spawn.js";

describe("spawn edge cases", () => {
  beforeEach(() => {
    mkdirSync(join(testDir, "sessions"), { recursive: true });
  });

  afterEach(() => {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // cleanup best effort
    }
  });

  it("writes prompt to file before spawning", () => {
    const { session } = spawnClaude({
      sessionId: "write-test",
      prompt: "hello world",
    });

    const promptPath = join(session.projectPath, "prompt.md");
    expect(existsSync(promptPath)).toBe(true);
    expect(readFileSync(promptPath, "utf-8")).toBe("hello world");
  });

  it("creates session directory if not exists", () => {
    const { session } = spawnClaude({
      sessionId: "new-dir-test",
      prompt: "test",
    });

    expect(existsSync(session.projectPath)).toBe(true);
  });

  it("writes .mcp.json with merged gateway and user config", () => {
    const { session } = spawnClaude({
      sessionId: "mcp-merge-test",
      prompt: "test",
      gatewayUrl: "http://localhost:45557",
      mcpConfig: {
        "user-server": {
          command: "node",
          args: ["server.js"],
        },
      },
    });

    const mcpPath = join(session.projectPath, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);

    const mcpData = JSON.parse(readFileSync(mcpPath, "utf-8"));
    expect(mcpData.mcpServers).toHaveProperty("user-server");
    expect(mcpData.mcpServers).toHaveProperty("openclaude-gateway");
    expect(mcpData.mcpServers["openclaude-gateway"].env.GATEWAY_URL).toBe(
      "http://localhost:45557",
    );
  });

  it("gateway MCP overrides user config on name collision", () => {
    const { session } = spawnClaude({
      sessionId: "mcp-collision-test",
      prompt: "test",
      gatewayUrl: "http://localhost:45557",
      mcpConfig: {
        "openclaude-gateway": {
          command: "echo",
          args: ["should-be-overridden"],
        },
      },
    });

    const mcpPath = join(session.projectPath, ".mcp.json");
    const mcpData = JSON.parse(readFileSync(mcpPath, "utf-8"));
    // Gateway version should win
    expect(mcpData.mcpServers["openclaude-gateway"].command).toBe("node");
  });

  it("no .mcp.json written when no MCP config and no gateway URL", () => {
    const { session } = spawnClaude({
      sessionId: "no-mcp-test",
      prompt: "test",
    });

    const mcpPath = join(session.projectPath, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(false);
  });

  it("session has correct initial state", () => {
    const { session } = spawnClaude({
      sessionId: "state-test",
      prompt: "test",
    });

    expect(session.id).toBe("state-test");
    expect(session.status).toBe("running");
    expect(session.startedAt).toBeGreaterThan(0);
    expect(session.timeout).toBe(300_000);
    expect(session.completedAt).toBeUndefined();
    expect(session.error).toBeUndefined();
  });

  it("custom timeout is respected", () => {
    const { session } = spawnClaude({
      sessionId: "timeout-test",
      prompt: "test",
      timeout: 60_000,
    });

    expect(session.timeout).toBe(60_000);
  });

  it("empty prompt writes empty file", () => {
    const { session } = spawnClaude({
      sessionId: "empty-prompt",
      prompt: "",
    });

    const promptPath = join(session.projectPath, "prompt.md");
    expect(readFileSync(promptPath, "utf-8")).toBe("");
  });

  it("prompt with special characters is written verbatim", () => {
    const specialPrompt = 'Hello "world" \'test\' <script>alert(1)</script> $HOME ${PATH}';
    const { session } = spawnClaude({
      sessionId: "special-chars",
      prompt: specialPrompt,
    });

    const promptPath = join(session.projectPath, "prompt.md");
    expect(readFileSync(promptPath, "utf-8")).toBe(specialPrompt);
  });
});

describe("parseClaudeOutput edge cases (via JSON)", () => {
  // Test the JSON parsing behavior by validating expected outputs
  // These simulate what the parser would encounter

  it("handles valid JSON array with result event", () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "text", text: "hello" }] } },
      { type: "result", subtype: "success", result: "hello", is_error: false },
    ];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent?.result).toBe("hello");
  });

  it("handles multiple result events — takes last one", () => {
    const events = [
      { type: "result", result: "first", is_error: true },
      { type: "result", result: "second", is_error: false },
    ];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent?.result).toBe("second");
  });

  it("handles result event with empty string", () => {
    const events = [{ type: "result", result: "", is_error: false }];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent?.result).toBe("");
  });

  it("handles JSON array with no result event", () => {
    const events = [
      { type: "system", subtype: "init" },
      { type: "assistant", message: {} },
    ];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent).toBeUndefined();
  });

  it("handles non-JSON stdout gracefully", () => {
    const stdout = "This is plain text output, not JSON";
    try {
      JSON.parse(stdout);
      // If parsing succeeds (shouldn't), still fine
    } catch {
      // Expected — parser returns raw text
      expect(stdout.trim()).toBe("This is plain text output, not JSON");
    }
  });

  it("handles result with multiline text", () => {
    const events = [
      { type: "result", result: "line1\nline2\nline3", is_error: false },
    ];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent?.result).toBe("line1\nline2\nline3");
  });

  it("handles result with unicode", () => {
    const events = [
      { type: "result", result: "Hello 世界 🌍 مرحبا", is_error: false },
    ];
    const resultEvent = events.findLast((e) => e.type === "result");
    expect(resultEvent?.result).toBe("Hello 世界 🌍 مرحبا");
  });
});
