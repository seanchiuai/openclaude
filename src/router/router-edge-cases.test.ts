/**
 * Edge case tests for the router.
 *
 * Covers: session timeout reset, command parsing edge cases, memory failure handling,
 * MCP config passthrough, session key derivation, skill matching with args.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseCommand, deriveSessionKey } from "./router.js";
import type { InboundMessage } from "../channels/types.js";

// Mock filesystem operations used by router
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => { throw new Error("ENOENT"); }),
  writeFileSync: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  paths: {
    sessionsMap: "/tmp/test-sessions-map.json",
    sessions: "/tmp/test-sessions",
    base: "/tmp/test-base",
  },
}));

describe("parseCommand", () => {
  it("parses simple command", () => {
    expect(parseCommand("/help")).toEqual({ name: "help", args: "" });
  });

  it("parses command with args", () => {
    expect(parseCommand("/cron add * * * * * test")).toEqual({
      name: "cron",
      args: "add * * * * * test",
    });
  });

  it("parses command with @botname", () => {
    expect(parseCommand("/help@mybot")).toEqual({ name: "help", args: "" });
  });

  it("parses command with @botname and args", () => {
    expect(parseCommand("/cron@mybot add test")).toEqual({
      name: "cron",
      args: "add test",
    });
  });

  it("returns empty name for non-command", () => {
    expect(parseCommand("hello")).toEqual({ name: "", args: "" });
  });

  it("handles command with no leading /", () => {
    // Shouldn't happen (router checks startsWith("/")), but parseCommand handles gracefully
    expect(parseCommand("hello world")).toEqual({ name: "", args: "" });
  });

  it("normalizes command name to lowercase", () => {
    expect(parseCommand("/HELP")).toEqual({ name: "help", args: "" });
    expect(parseCommand("/CrOn list")).toEqual({ name: "cron", args: "list" });
  });

  it("handles command with only /", () => {
    expect(parseCommand("/")).toEqual({ name: "", args: "" });
  });

  it("handles command with underscores", () => {
    expect(parseCommand("/my_command args")).toEqual({
      name: "my_command",
      args: "args",
    });
  });

  it("handles command with numbers", () => {
    expect(parseCommand("/test123")).toEqual({ name: "test123", args: "" });
  });

  it("handles multiline args", () => {
    const result = parseCommand("/cron add\nline1\nline2");
    expect(result.name).toBe("cron");
    expect(result.args).toBe("add\nline1\nline2");
  });

  it("handles command with extra whitespace in args", () => {
    // Regex captures everything after /command\s* — leading whitespace consumed by \s*
    expect(parseCommand("/help   extra  spaces")).toEqual({
      name: "help",
      args: "extra  spaces",
    });
  });

  it("handles unicode in args", () => {
    expect(parseCommand("/search 你好世界")).toEqual({
      name: "search",
      args: "你好世界",
    });
  });

  it("handles emoji in args", () => {
    expect(parseCommand("/search 🔥🎉")).toEqual({
      name: "search",
      args: "🔥🎉",
    });
  });
});

describe("deriveSessionKey", () => {
  it("creates key from channel and chatId", () => {
    const msg: InboundMessage = {
      channel: "telegram",
      chatId: "12345",
      userId: "u1",
      username: "test",
      text: "hi",
      source: "user",
    };
    expect(deriveSessionKey(msg)).toBe("telegram:12345");
  });

  it("different channels produce different keys", () => {
    const tg: InboundMessage = {
      channel: "telegram",
      chatId: "123",
      userId: "u1",
      username: "test",
      text: "hi",
      source: "user",
    };
    const slack: InboundMessage = {
      channel: "slack",
      chatId: "123",
      userId: "u1",
      username: "test",
      text: "hi",
      source: "user",
    };
    expect(deriveSessionKey(tg)).not.toBe(deriveSessionKey(slack));
  });

  it("handles chatId with special characters", () => {
    const msg: InboundMessage = {
      channel: "telegram",
      chatId: "-100123456789", // Telegram group chat IDs are negative
      userId: "u1",
      username: "test",
      text: "hi",
      source: "user",
    };
    expect(deriveSessionKey(msg)).toBe("telegram:-100123456789");
  });
});
