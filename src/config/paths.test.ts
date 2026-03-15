import { describe, it, expect, afterEach, vi } from "vitest";

describe("paths", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("defaults to ~/.openclaude", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "");
    const { paths } = await import("./paths.js");
    expect(paths.base).toMatch(/\.openclaude$/);
  });

  it("respects OPENCLAUDE_STATE_DIR override", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "/tmp/test-openclaude");
    vi.resetModules();
    const { paths } = await import("./paths.js");
    expect(paths.base).toBe("/tmp/test-openclaude");
    expect(paths.config).toBe("/tmp/test-openclaude/config.json");
    expect(paths.sessions).toBe("/tmp/test-openclaude/sessions");
    expect(paths.pidFile).toBe("/tmp/test-openclaude/gateway.pid");
  });

  it("expands tilde in OPENCLAUDE_STATE_DIR", async () => {
    vi.stubEnv("OPENCLAUDE_STATE_DIR", "~/.openclaude-dev");
    vi.resetModules();
    const { paths } = await import("./paths.js");
    expect(paths.base).not.toContain("~");
    expect(paths.base).toMatch(/\.openclaude-dev$/);
  });
});
