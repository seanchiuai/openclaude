import { describe, expect, it } from "vitest";
import {
  buildCronEventPrompt,
  buildExecEventPrompt,
  isCronSystemEvent,
  isExecCompletionEvent,
} from "./heartbeat-events-filter.js";

describe("heartbeat event prompts", () => {
  it("builds user-relay cron prompt by default", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"]);
    expect(prompt).toContain("Please relay this reminder to the user");
  });

  it("builds internal-only cron prompt when delivery is disabled", () => {
    const prompt = buildCronEventPrompt(["Cron: rotate logs"], { deliverToUser: false });
    expect(prompt).toContain("Handle this reminder internally");
    expect(prompt).not.toContain("Please relay this reminder to the user");
  });

  it("builds internal-only exec prompt when delivery is disabled", () => {
    const prompt = buildExecEventPrompt({ deliverToUser: false });
    expect(prompt).toContain("Handle the result internally");
    expect(prompt).not.toContain("Please relay the command output to the user");
  });

  it("builds empty cron event prompt with HEARTBEAT_OK fallback", () => {
    const prompt = buildCronEventPrompt([]);
    expect(prompt).toContain("Reply HEARTBEAT_OK");
  });

  it("builds empty internal cron event prompt", () => {
    const prompt = buildCronEventPrompt([], { deliverToUser: false });
    expect(prompt).toContain("Handle this internally");
  });
});

describe("event classification", () => {
  it("detects exec completion events", () => {
    expect(isExecCompletionEvent("exec finished")).toBe(true);
    expect(isExecCompletionEvent("some exec finished here")).toBe(true);
    expect(isExecCompletionEvent("task completed")).toBe(false);
  });

  it("classifies real cron system events", () => {
    expect(isCronSystemEvent("Cron: daily standup")).toBe(true);
    expect(isCronSystemEvent("HEARTBEAT_OK")).toBe(false);
    expect(isCronSystemEvent("heartbeat poll")).toBe(false);
    expect(isCronSystemEvent("heartbeat wake")).toBe(false);
    expect(isCronSystemEvent("exec finished")).toBe(false);
    expect(isCronSystemEvent("")).toBe(false);
    expect(isCronSystemEvent("  ")).toBe(false);
  });
});
