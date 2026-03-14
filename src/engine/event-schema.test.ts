// src/engine/event-schema.test.ts
import { describe, it, expect } from "vitest";
import { classifyEvent, type ClassifiedEvent } from "./event-schema.js";

describe("classifyEvent", () => {
  it("classifies init event and extracts session_id", () => {
    const event = { type: "system", subtype: "init", session_id: "abc-123" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "init", sessionId: "abc-123" });
  });

  it("classifies result event and extracts fields", () => {
    const event = {
      type: "result",
      result: "Hello!",
      num_turns: 2,
      total_cost_usd: 0.01,
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 10,
        cache_creation_input_tokens: 5,
      },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "result",
      text: "Hello!",
      numTurns: 2,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: 10,
        cacheCreationTokens: 5,
        totalCostUsd: 0.01,
      },
    });
  });

  it("classifies result event with missing usage gracefully", () => {
    const event = { type: "result", result: "Done" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "result", text: "Done", numTurns: undefined, usage: undefined });
  });

  it("classifies compact_boundary event", () => {
    const event = {
      type: "system",
      subtype: "compact_boundary",
      compact_metadata: { pre_tokens: 180000 },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "compaction", preTokens: 180000 });
  });

  it("classifies assistant text content", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hi" }] },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "assistant",
      textBlocks: ["Hi"],
      toolUseNames: [],
    });
  });

  it("classifies assistant tool_use content", () => {
    const event = {
      type: "assistant",
      message: { content: [{ type: "tool_use", name: "Read" }] },
    };
    const result = classifyEvent(event);
    expect(result).toEqual({
      kind: "assistant",
      textBlocks: [],
      toolUseNames: ["Read"],
    });
  });

  it("returns unknown for unrecognized event types", () => {
    const event = { type: "something_new", data: "future" };
    const result = classifyEvent(event);
    expect(result).toEqual({ kind: "unknown" });
  });

  it("returns unknown for events missing type field", () => {
    const result = classifyEvent({ data: "no type" });
    expect(result).toEqual({ kind: "unknown" });
  });
});
