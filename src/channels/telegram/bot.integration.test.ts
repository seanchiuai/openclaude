import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { AddressInfo } from "node:net";
import { Bot } from "grammy";
import { createTestContext } from "../../../test/helpers/test-context.js";

describe("telegram bot integration (mock API)", () => {
  const ctx = createTestContext("telegram-integration");

  const app = new Hono();
  let server: ReturnType<typeof serve>;
  let apiRoot: string;

  const captured: {
    sendMessage: Array<{ chat_id: number; text: string }>;
    sendChatAction: Array<{ chat_id: number; action: string }>;
  } = {
    sendMessage: [],
    sendChatAction: [],
  };

  // Mock Telegram Bot API endpoints
  // grammY sends requests to {apiRoot}/bot{token}/{method}
  // e.g. http://127.0.0.1:PORT/botTOKEN/getMe
  // Hono's :token param captures the full segment including the "bot" prefix
  app.post("/:botToken/getMe", (c) => {
    ctx.log("getMe called");
    return c.json({
      ok: true,
      result: {
        id: 12345,
        is_bot: true,
        first_name: "TestBot",
        username: "test_bot",
      },
    });
  });

  app.post("/:botToken/getUpdates", (c) => {
    ctx.log("getUpdates called");
    return c.json({ ok: true, result: [] });
  });

  app.post("/:botToken/sendMessage", async (c) => {
    const body = await c.req.json();
    ctx.log("sendMessage called", body);
    captured.sendMessage.push({ chat_id: body.chat_id, text: body.text });
    return c.json({
      ok: true,
      result: {
        message_id: captured.sendMessage.length,
        chat: { id: Number(body.chat_id) },
        text: body.text,
        date: Math.floor(Date.now() / 1000),
      },
    });
  });

  app.post("/:botToken/sendChatAction", async (c) => {
    const body = await c.req.json();
    ctx.log("sendChatAction called", body);
    captured.sendChatAction.push({
      chat_id: body.chat_id,
      action: body.action,
    });
    return c.json({ ok: true, result: true });
  });

  app.post("/:botToken/setMessageReaction", (c) => {
    ctx.log("setMessageReaction called");
    return c.json({ ok: true, result: true });
  });

  beforeAll(async () => {
    server = serve({ fetch: app.fetch, port: 0 });
    const addr = server.address() as AddressInfo;
    apiRoot = `http://127.0.0.1:${addr.port}`;
    ctx.log(`Mock Telegram API started on ${apiRoot}`);
  });

  afterAll(() => {
    server?.close();
  });

  it("bot.init() returns correct bot info from mock API", async () => {
    ctx.dumpOnFailure();

    const bot = new Bot("test-token-123", {
      client: { apiRoot },
    });

    await bot.init();

    expect(bot.botInfo.id).toBe(12345);
    expect(bot.botInfo.is_bot).toBe(true);
    expect(bot.botInfo.first_name).toBe("TestBot");
    expect(bot.botInfo.username).toBe("test_bot");
  });

  it("bot.api.sendMessage() delivers message and is captured by mock", async () => {
    ctx.dumpOnFailure();

    const bot = new Bot("test-token-456", {
      client: { apiRoot },
    });
    await bot.init();

    const chatId = 42;
    const text = "Hello from integration test!";

    const result = await bot.api.sendMessage(chatId, text);

    expect(result.text).toBe(text);
    expect(result.chat.id).toBe(chatId);
    expect(result.message_id).toBeGreaterThan(0);

    const last = captured.sendMessage[captured.sendMessage.length - 1];
    expect(last.chat_id).toBe(chatId);
    expect(last.text).toBe(text);
  });

  it("bot.api.sendChatAction() works without throwing", async () => {
    ctx.dumpOnFailure();

    const bot = new Bot("test-token-789", {
      client: { apiRoot },
    });
    await bot.init();

    await expect(
      bot.api.sendChatAction(99, "typing"),
    ).resolves.toBe(true);

    const last = captured.sendChatAction[captured.sendChatAction.length - 1];
    expect(last.chat_id).toBe(99);
    expect(last.action).toBe("typing");
  });
});
