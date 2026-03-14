import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildChildSystemPrompt } from "./system-prompt.js";

describe("buildSystemPrompt promptMode", () => {
  it("full mode includes all sections", () => {
    const prompt = buildSystemPrompt({
      promptMode: "full",
      hasGatewayTools: true,
      skills: [{ name: "test", description: "test skill", body: "do stuff", triggers: ["/test"], invocation: {} as never }],
    });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("## Reply Tags");
    expect(prompt).toContain("## Messaging");
    expect(prompt).toContain("## Silent Replies");
    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("## Gateway Tools");
  });

  it("minimal mode skips full-mode-only sections", () => {
    const prompt = buildSystemPrompt({
      promptMode: "minimal",
      hasGatewayTools: true,
      skills: [{ name: "test", description: "test skill", body: "do stuff", triggers: ["/test"], invocation: {} as never }],
    });
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Reply Tags");
    expect(prompt).not.toContain("## Messaging");
    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).not.toContain("## Heartbeats");
    // Should still include core sections
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Tool Call Style");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Gateway Tools");
  });

  it("none mode returns just the identity line", () => {
    const prompt = buildSystemPrompt({ promptMode: "none" });
    expect(prompt).toBe("You are a personal assistant running inside OpenClaude.");
  });

  it("minimal mode uses 'Subagent Context' header for extra system prompt", () => {
    const prompt = buildSystemPrompt({
      promptMode: "minimal",
      extraSystemPrompt: "You are helping with research.",
    });
    expect(prompt).toContain("## Subagent Context");
    expect(prompt).not.toContain("## Additional Context");
  });

  it("full mode uses 'Additional Context' header for extra system prompt", () => {
    const prompt = buildSystemPrompt({
      promptMode: "full",
      extraSystemPrompt: "Group chat context here.",
    });
    expect(prompt).toContain("## Additional Context");
    expect(prompt).not.toContain("## Subagent Context");
  });

  it("includes sessions_status and logs_tail in gateway tools", () => {
    const prompt = buildSystemPrompt({ hasGatewayTools: true });
    expect(prompt).toContain("sessions_status");
    expect(prompt).toContain("logs_tail");
  });

  it("includes anti-polling guidance", () => {
    const prompt = buildSystemPrompt({ hasGatewayTools: true });
    expect(prompt).toContain("Do not poll sessions_status in a loop");
  });
});

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
