import { describe, it, expect } from "vitest";
import { buildChildSystemPrompt } from "./system-prompt.js";

describe("buildChildSystemPrompt", () => {
  it("includes the task description", () => {
    const prompt = buildChildSystemPrompt("research quantum computing", "main session");
    expect(prompt).toContain("research quantum computing");
  });

  it("instructs not to spawn or message", () => {
    const prompt = buildChildSystemPrompt("do something", "parent");
    expect(prompt).toContain("Do not attempt to spawn");
    expect(prompt).toContain("Do not attempt to message");
  });

  it("lists available memory tools", () => {
    const prompt = buildChildSystemPrompt("do something", "parent");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
  });
});
