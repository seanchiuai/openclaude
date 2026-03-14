import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildChildSystemPrompt } from "./system-prompt.js";

const SKILL_FIXTURE = {
  name: "test",
  description: "test skill",
  body: "do stuff",
  triggers: ["/test"],
  invocation: {} as never,
};

describe("buildSystemPrompt promptMode", () => {
  it("full mode includes all sections", () => {
    const prompt = buildSystemPrompt({
      promptMode: "full",
      hasGatewayTools: true,
      skills: [SKILL_FIXTURE],
    });
    expect(prompt).toContain("## Skills");
    expect(prompt).toContain("## Memory Recall");
    expect(prompt).toContain("## Reply Tags");
    expect(prompt).toContain("## Messaging");
    expect(prompt).toContain("## Silent Replies");
    expect(prompt).toContain("## Heartbeats");
    expect(prompt).toContain("## Tools");
  });

  it("minimal mode skips full-mode-only sections", () => {
    const prompt = buildSystemPrompt({
      promptMode: "minimal",
      hasGatewayTools: true,
      skills: [SKILL_FIXTURE],
    });
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("## Memory Recall");
    expect(prompt).not.toContain("## Reply Tags");
    // "## Messaging" is the full messaging section; "### Messaging" in tools is OK
    expect(prompt).not.toMatch(/^## Messaging$/m);
    expect(prompt).not.toContain("## Silent Replies");
    expect(prompt).not.toContain("## Heartbeats");
    // Should still include core sections
    expect(prompt).toContain("## Safety");
    expect(prompt).toContain("## Behavior");
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Tools");
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

  it("includes sessions_status and logs_tail in tools", () => {
    const prompt = buildSystemPrompt({ hasGatewayTools: true });
    expect(prompt).toContain("sessions_status");
    expect(prompt).toContain("logs_tail");
  });

  it("includes anti-polling guidance", () => {
    const prompt = buildSystemPrompt({ hasGatewayTools: true });
    expect(prompt).toContain("Never poll in a loop");
  });
});

describe("buildSystemPrompt 12-factor compliance", () => {
  it("Factor 4: tools include input/output contracts", () => {
    const prompt = buildSystemPrompt({ hasGatewayTools: true });
    // Tool descriptions should show param shapes and return types
    expect(prompt).toContain("→ {");
    expect(prompt).toContain("cron_add({name, schedule:");
    expect(prompt).toContain("memory_search({query");
    expect(prompt).toContain("send_message({channel, chatId, text})");
  });

  it("Factor 8: skills section has explicit decision tree", () => {
    const prompt = buildSystemPrompt({
      skills: [SKILL_FIXTURE],
    });
    expect(prompt).toContain("Decision tree:");
    expect(prompt).toMatch(/1\..+skill/i);
    expect(prompt).toMatch(/2\..+trigger/i);
    expect(prompt).toMatch(/3\..+No match/i);
  });

  it("Factor 10: child prompt is narrowly scoped", () => {
    const prompt = buildChildSystemPrompt("summarize logs", "main-abc");
    // Should NOT contain sections meant for full agents
    expect(prompt).not.toContain("## Skills");
    expect(prompt).not.toContain("Silent Replies");
    expect(prompt).not.toContain("Heartbeats");
    // Tools section should only list memory tools — send_message and sessions_spawn
    // are mentioned only in constraints (what the child cannot do), not as available tools
    expect(prompt).not.toContain("## Messaging");
    expect(prompt).not.toContain("## Cron");
    // Should contain only what the child needs
    expect(prompt).toContain("summarize logs");
    expect(prompt).toContain("memory_search");
    expect(prompt).toContain("memory_get");
  });

  it("Factor 12: output tokens are documented as deterministic signals", () => {
    const prompt = buildSystemPrompt({ promptMode: "full" });
    expect(prompt).toContain("Output token: NO_REPLY");
    expect(prompt).toContain("Output token: HEARTBEAT_OK");
  });

  it("Factor 3: minimal mode has fewer tokens than full mode", () => {
    const fullPrompt = buildSystemPrompt({
      promptMode: "full",
      hasGatewayTools: true,
      skills: [SKILL_FIXTURE],
    });
    const minimalPrompt = buildSystemPrompt({
      promptMode: "minimal",
      hasGatewayTools: true,
      skills: [SKILL_FIXTURE],
    });
    expect(minimalPrompt.length).toBeLessThan(fullPrompt.length);
  });
});

describe("buildChildSystemPrompt", () => {
  it("includes the task description", () => {
    const prompt = buildChildSystemPrompt("research quantum computing", "main session");
    expect(prompt).toContain("research quantum computing");
  });

  it("instructs not to spawn or message", () => {
    const prompt = buildChildSystemPrompt("do something", "parent");
    expect(prompt).toContain("Do NOT spawn");
    expect(prompt).toContain("Do NOT message");
  });

  it("lists available memory tools with contracts", () => {
    const prompt = buildChildSystemPrompt("do something", "parent");
    expect(prompt).toContain("memory_search({query");
    expect(prompt).toContain("memory_get({path");
  });

  it("tells child it cannot ask for clarification", () => {
    const prompt = buildChildSystemPrompt("ambiguous task", "parent");
    expect(prompt).toContain("cannot ask for clarification");
  });
});
