import { describe, it, expect, vi, beforeEach } from "vitest";
import type { InboundMessage, MessageHandler } from "../types.js";

const botInfo = { id: 12345, is_bot: true, first_name: "TestBot", username: "testbot" };

vi.mock("grammy", () => {
  const handlers = new Map();
  return {
    Bot: vi.fn().mockImplementation(() => ({
      api: { config: { use: vi.fn() }, sendMessage: vi.fn(), sendChatAction: vi.fn().mockResolvedValue(true), setMessageReaction: vi.fn().mockResolvedValue(true) },
      on: vi.fn((event: string, handler: unknown) =>
        handlers.set(event, handler),
      ),
      start: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockResolvedValue(undefined),
      botInfo,
      _handlers: handlers,
    })),
  };
});
vi.mock("@grammyjs/transformer-throttler", () => ({
  apiThrottler: vi.fn().mockReturnValue(() => {}),
}));
vi.mock("./send.js", () => ({
  sendText: vi.fn().mockResolvedValue({ messageId: 1, success: true }),
  sendMedia: vi.fn().mockResolvedValue({ messageId: 2, success: true }),
}));

import { createTelegramChannel } from "./bot.js";
import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";

function getBotInstance(): ReturnType<typeof Bot> & {
  _handlers: Map<string, (ctx: unknown) => Promise<void>>;
} {
  const calls = vi.mocked(Bot).mock.results;
  return calls[calls.length - 1].value as ReturnType<typeof Bot> & {
    _handlers: Map<string, (ctx: unknown) => Promise<void>>;
  };
}

function makeTextCtx(overrides: {
  chatId?: number;
  userId?: number;
  username?: string;
  text?: string;
  chatType?: string;
  replyToMessage?: object;
  messageId?: number;
}) {
  return {
    from: {
      id: overrides.userId ?? 100,
      username: overrides.username ?? "testuser",
      first_name: "Test",
    },
    chat: { id: overrides.chatId ?? 999, type: overrides.chatType ?? "private" },
    message: {
      message_id: overrides.messageId ?? 1,
      text: overrides.text ?? "hello",
      ...(overrides.replyToMessage ? { reply_to_message: overrides.replyToMessage } : {}),
    },
  };
}

function makePhotoCtx(overrides: {
  chatId?: number;
  userId?: number;
  username?: string;
  caption?: string;
  chatType?: string;
  messageId?: number;
}) {
  return {
    from: {
      id: overrides.userId ?? 100,
      username: overrides.username ?? "testuser",
      first_name: "Test",
    },
    chat: { id: overrides.chatId ?? 999, type: overrides.chatType ?? "private" },
    message: {
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption ?? "photo caption",
      photo: [
        { file_id: "small_id", width: 100, height: 100 },
        { file_id: "medium_id", width: 320, height: 320 },
        { file_id: "large_id", width: 800, height: 800 },
      ],
    },
  };
}

function makeDocCtx(overrides: {
  chatId?: number;
  userId?: number;
  username?: string;
  caption?: string;
  chatType?: string;
  messageId?: number;
}) {
  return {
    from: {
      id: overrides.userId ?? 100,
      username: overrides.username ?? "testuser",
      first_name: "Test",
    },
    chat: { id: overrides.chatId ?? 999, type: overrides.chatType ?? "private" },
    message: {
      message_id: overrides.messageId ?? 1,
      caption: overrides.caption ?? "",
      document: {
        file_id: "doc_file_id",
        mime_type: "application/pdf",
        file_name: "report.pdf",
      },
    },
  };
}

describe("createTelegramChannel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("creates bot with provided token", () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createTelegramChannel(
      { enabled: true, botToken: "test-token-123" },
      handler,
    );

    expect(Bot).toHaveBeenCalledWith("test-token-123");
  });

  it("applies API throttler", () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createTelegramChannel(
      { enabled: true, botToken: "test-token" },
      handler,
    );

    const bot = getBotInstance();
    expect(apiThrottler).toHaveBeenCalled();
    expect(bot.api.config.use).toHaveBeenCalled();
  });

  it("normalizes text message into InboundMessage with correct fields", async () => {
    const handler = vi.fn().mockResolvedValue("response");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({
      chatId: 42,
      userId: 7,
      username: "alice",
      text: "hi there",
    });

    await textHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.channel).toBe("telegram");
    expect(msg.chatId).toBe("42");
    expect(msg.userId).toBe("7");
    expect(msg.username).toBe("alice");
    expect(msg.text).toBe("hi there");
    expect(msg.source).toBe("user");
  });

  it("photo message includes media attachment with fileId from largest photo", async () => {
    const handler = vi.fn().mockResolvedValue("got it");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const photoHandler = bot._handlers.get("message:photo")!;
    const ctx = makePhotoCtx({ userId: 10, chatId: 55 });

    await photoHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.media).toBeDefined();
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0].type).toBe("photo");
    expect(msg.media![0].fileId).toBe("large_id");
  });

  it("document message includes media attachment with fileId, mimeType, fileName", async () => {
    const handler = vi.fn().mockResolvedValue("noted");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const docHandler = bot._handlers.get("message:document")!;
    const ctx = makeDocCtx({ userId: 10, chatId: 55 });

    await docHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.media).toBeDefined();
    expect(msg.media).toHaveLength(1);
    expect(msg.media![0].type).toBe("document");
    expect(msg.media![0].fileId).toBe("doc_file_id");
    expect(msg.media![0].mimeType).toBe("application/pdf");
    expect(msg.media![0].fileName).toBe("report.pdf");
  });

  it("allow-list blocks unauthorized user", async () => {
    const handler = vi.fn().mockResolvedValue("should not see this");
    createTelegramChannel(
      { enabled: true, botToken: "token", allowFrom: [999] },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ userId: 123 }); // not in allowFrom

    await textHandler(ctx);

    expect(handler).not.toHaveBeenCalled();
  });

  it("allow-list allows authorized user", async () => {
    const handler = vi.fn().mockResolvedValue("allowed");
    createTelegramChannel(
      { enabled: true, botToken: "token", allowFrom: [100] },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ userId: 100 });

    await textHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("no allow-list (allowFrom undefined) allows all users", async () => {
    const handler = vi.fn().mockResolvedValue("welcome");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ userId: 777 });

    await textHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
  });

  it("stop() calls bot.stop()", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    const adapter = createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    await adapter.stop();

    expect(bot.stop).toHaveBeenCalled();
  });

  it("handler returning empty string does not call sendText", async () => {
    const handler = vi.fn().mockResolvedValue("");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ text: "hello" });

    await textHandler(ctx);

    const { sendText } = await import("./send.js");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("handler returning null/undefined does not call sendText", async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ text: "hello" });

    await textHandler(ctx);

    const { sendText } = await import("./send.js");
    expect(sendText).not.toHaveBeenCalled();
  });

  it("photo message with no caption uses empty string", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const photoHandler = bot._handlers.get("message:photo")!;
    const ctx = makePhotoCtx({ userId: 10, chatId: 55 });
    // Force caption to undefined to simulate no caption
    ctx.message.caption = undefined as unknown as string;

    await photoHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.text).toBe("");
  });

  describe("requireMention gating", () => {
    it("skips group message with no mention when requireMention is true", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({ text: "hello everyone", chatType: "supergroup" });

      await textHandler(ctx);
      expect(handler).not.toHaveBeenCalled();
    });

    it("responds when @testbot in text", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({ text: "hey @testbot what's up", chatType: "group" });

      await textHandler(ctx);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("responds when reply to bot message", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({
        text: "follow up",
        chatType: "group",
        replyToMessage: { from: { id: 12345 } },
      });

      await textHandler(ctx);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("always responds in DMs", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({ text: "hello", chatType: "private" });

      await textHandler(ctx);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("responds to all when requireMention is false", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: false },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({ text: "hello", chatType: "supergroup" });

      await textHandler(ctx);
      expect(handler).toHaveBeenCalledOnce();
    });

    it("defaults to true (no config field) — skips group msg", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token" },
        handler,
      );

      const bot = getBotInstance();
      const textHandler = bot._handlers.get("message:text")!;
      const ctx = makeTextCtx({ text: "hello", chatType: "group" });

      await textHandler(ctx);
      expect(handler).not.toHaveBeenCalled();
    });

    it("applies to photo messages", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const photoHandler = bot._handlers.get("message:photo")!;
      const ctx = makePhotoCtx({ chatType: "group" });

      await photoHandler(ctx);
      expect(handler).not.toHaveBeenCalled();
    });

    it("applies to document messages", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const docHandler = bot._handlers.get("message:document")!;
      const ctx = makeDocCtx({ chatType: "group" });

      await docHandler(ctx);
      expect(handler).not.toHaveBeenCalled();
    });

    it("photo caption @mention passes", async () => {
      const handler = vi.fn().mockResolvedValue("ok");
      createTelegramChannel(
        { enabled: true, botToken: "token", requireMention: true },
        handler,
      );

      const bot = getBotInstance();
      const photoHandler = bot._handlers.get("message:photo")!;
      const ctx = makePhotoCtx({ chatType: "group", caption: "look @testbot" });

      await photoHandler(ctx);
      expect(handler).toHaveBeenCalledOnce();
    });
  });

  it("username falls back to first_name when username is undefined", async () => {
    const handler = vi.fn().mockResolvedValue("ok");
    createTelegramChannel(
      { enabled: true, botToken: "token" },
      handler,
    );

    const bot = getBotInstance();
    const textHandler = bot._handlers.get("message:text")!;
    const ctx = makeTextCtx({ text: "hello" });
    // Set username to undefined to trigger fallback
    ctx.from.username = undefined as unknown as string;

    await textHandler(ctx);

    expect(handler).toHaveBeenCalledOnce();
    const msg: InboundMessage = handler.mock.calls[0][0];
    expect(msg.username).toBe("Test");
  });
});
