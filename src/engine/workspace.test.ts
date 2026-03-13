import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadWorkspaceBootstrapFiles,
  buildBootstrapContextFiles,
  filterBootstrapFilesForMinimal,
} from "./workspace.js";

describe("loadWorkspaceBootstrapFiles", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "openclaude-workspace-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("loads existing files and marks missing ones", () => {
    writeFileSync(join(tempDir, "AGENTS.md"), "Agent instructions here");
    writeFileSync(join(tempDir, "SOUL.md"), "Be friendly and helpful.");

    const files = loadWorkspaceBootstrapFiles(tempDir);

    const agents = files.find((f) => f.name === "AGENTS.md");
    expect(agents).toBeDefined();
    expect(agents!.missing).toBe(false);
    expect(agents!.content).toBe("Agent instructions here");

    const soul = files.find((f) => f.name === "SOUL.md");
    expect(soul).toBeDefined();
    expect(soul!.missing).toBe(false);
    expect(soul!.content).toBe("Be friendly and helpful.");

    const tools = files.find((f) => f.name === "TOOLS.md");
    expect(tools).toBeDefined();
    expect(tools!.missing).toBe(true);
    expect(tools!.content).toBeUndefined();
  });

  it("returns all expected file names in order", () => {
    const files = loadWorkspaceBootstrapFiles(tempDir);
    const names = files.map((f) => f.name);

    expect(names).toContain("AGENTS.md");
    expect(names).toContain("SOUL.md");
    expect(names).toContain("TOOLS.md");
    expect(names).toContain("IDENTITY.md");
    expect(names).toContain("USER.md");
    expect(names).toContain("HEARTBEAT.md");
    expect(names).toContain("BOOTSTRAP.md");
    expect(names).toContain("MEMORY.md");
  });

  it("handles empty workspace directory", () => {
    const files = loadWorkspaceBootstrapFiles(tempDir);
    expect(files.every((f) => f.missing)).toBe(true);
  });
});

describe("filterBootstrapFilesForMinimal", () => {
  it("keeps only AGENTS, TOOLS, SOUL, IDENTITY, USER", () => {
    const files = [
      { name: "AGENTS.md", path: "/a", content: "agents", missing: false },
      { name: "SOUL.md", path: "/b", content: "soul", missing: false },
      { name: "TOOLS.md", path: "/c", content: "tools", missing: false },
      { name: "IDENTITY.md", path: "/d", content: "identity", missing: false },
      { name: "USER.md", path: "/e", content: "user", missing: false },
      { name: "HEARTBEAT.md", path: "/f", content: "heartbeat", missing: false },
      { name: "BOOTSTRAP.md", path: "/g", content: "bootstrap", missing: false },
      { name: "MEMORY.md", path: "/h", content: "memory", missing: false },
    ];

    const minimal = filterBootstrapFilesForMinimal(files);
    const names = minimal.map((f) => f.name);

    expect(names).toEqual([
      "AGENTS.md",
      "SOUL.md",
      "TOOLS.md",
      "IDENTITY.md",
      "USER.md",
    ]);
  });
});

describe("buildBootstrapContextFiles", () => {
  it("builds context files from non-missing bootstrap files", () => {
    const files = [
      { name: "AGENTS.md", path: "/a", content: "Agent rules", missing: false },
      { name: "SOUL.md", path: "/b", missing: true },
      { name: "TOOLS.md", path: "/c", content: "Tool usage", missing: false },
    ];

    const { contextFiles, truncationWarnings } = buildBootstrapContextFiles(files as any);

    expect(contextFiles).toHaveLength(2);
    expect(contextFiles[0]).toEqual({ path: "AGENTS.md", content: "Agent rules" });
    expect(contextFiles[1]).toEqual({ path: "TOOLS.md", content: "Tool usage" });
    expect(truncationWarnings).toHaveLength(0);
  });

  it("truncates files exceeding per-file limit", () => {
    const longContent = "x".repeat(500);
    const files = [
      { name: "AGENTS.md", path: "/a", content: longContent, missing: false },
    ];

    const { contextFiles, truncationWarnings } = buildBootstrapContextFiles(
      files as any,
      { fileMaxChars: 100 },
    );

    expect(contextFiles).toHaveLength(1);
    expect(contextFiles[0]!.content.length).toBeLessThan(longContent.length);
    expect(contextFiles[0]!.content).toContain("truncated");
    expect(truncationWarnings).toHaveLength(1);
    expect(truncationWarnings[0]).toContain("AGENTS.md");
  });

  it("enforces total budget across multiple files", () => {
    const files = [
      { name: "AGENTS.md", path: "/a", content: "a".repeat(80), missing: false },
      { name: "SOUL.md", path: "/b", content: "b".repeat(80), missing: false },
    ];

    const { contextFiles, truncationWarnings } = buildBootstrapContextFiles(
      files as any,
      { fileMaxChars: 1000, totalMaxChars: 100 },
    );

    // First file fits (80 chars), second gets clamped (only 20 chars remaining)
    expect(contextFiles).toHaveLength(2);
    expect(contextFiles[0]!.content).toBe("a".repeat(80));
    expect(contextFiles[1]!.content.length).toBeLessThanOrEqual(21); // 20 + "…"
    expect(truncationWarnings.length).toBeGreaterThan(0);
  });

  it("skips files when total budget is exhausted", () => {
    const files = [
      { name: "AGENTS.md", path: "/a", content: "a".repeat(100), missing: false },
      { name: "SOUL.md", path: "/b", content: "b".repeat(50), missing: false },
    ];

    const { contextFiles, truncationWarnings } = buildBootstrapContextFiles(
      files as any,
      { fileMaxChars: 1000, totalMaxChars: 100 },
    );

    expect(contextFiles).toHaveLength(1);
    expect(truncationWarnings).toHaveLength(1);
    expect(truncationWarnings[0]).toContain("skipped");
  });
});
