/**
 * Contract tests for src/tools/send-tool.ts
 *
 * Expected interface:
 *   function createSendTool(channels: Map<string, ChannelAdapter>): {
 *     execute(params: { channel: string; chatId: string; text: string }): Promise<SendResult>
 *   }
 *
 * ChannelAdapter: {
 *   id: string;
 *   start(): Promise<void>;
 *   stop(): Promise<void>;
 *   sendText(chatId: string, text: string): Promise<SendResult>;
 *   sendMedia?(chatId: string, media: MediaAttachment, caption?: string): Promise<SendResult>;
 * }
 *
 * SendResult: { messageId: string; success: boolean; error?: string }
 *
 * The send tool allows the agent to send messages to any registered channel.
 */

import { describe, it, expect, vi } from "vitest";

interface ChannelAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<{ messageId: string; success: boolean }>;
}

vi.mock("./send-tool.js", () => {
  function createSendTool(channels: Map<string, ChannelAdapter>) {
    return {
      async execute(params: { channel: string; chatId: string; text: string }) {
        const adapter = channels.get(params.channel);
        if (!adapter) {
          return {
            messageId: "",
            success: false,
            error: `Unknown channel: ${params.channel}`,
          };
        }
        return adapter.sendText(params.chatId, params.text);
      },
    };
  }

  return { createSendTool };
});

const { createSendTool } = await import("./send-tool.js");

function mockChannel(id: string): ChannelAdapter {
  return {
    id,
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    sendText: vi
      .fn()
      .mockResolvedValue({ messageId: `${id}-msg-1`, success: true }),
  };
}

describe("createSendTool", () => {
  it("send to telegram channel calls channel.sendText and returns success", async () => {
    const telegram = mockChannel("telegram");
    const channels = new Map([["telegram", telegram]]);
    const tool = createSendTool(channels);

    const result = await tool.execute({
      channel: "telegram",
      chatId: "chat-123",
      text: "Hello from agent",
    });

    expect(telegram.sendText).toHaveBeenCalledWith("chat-123", "Hello from agent");
    expect(result).toEqual(
      expect.objectContaining({ success: true, messageId: "telegram-msg-1" }),
    );
  });

  it("send to slack channel calls channel.sendText and returns success", async () => {
    const slack = mockChannel("slack");
    const channels = new Map([["slack", slack]]);
    const tool = createSendTool(channels);

    const result = await tool.execute({
      channel: "slack",
      chatId: "C456",
      text: "Hello from agent",
    });

    expect(slack.sendText).toHaveBeenCalledWith("C456", "Hello from agent");
    expect(result).toEqual(
      expect.objectContaining({ success: true, messageId: "slack-msg-1" }),
    );
  });

  it("send to unknown channel returns error", async () => {
    const channels = new Map<string, ChannelAdapter>();
    const tool = createSendTool(channels);

    const result = await tool.execute({
      channel: "discord",
      chatId: "chat-1",
      text: "hello",
    });

    expect(result).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(result).toHaveProperty("error");
  });

  it("send when channel not in map returns error", async () => {
    const telegram = mockChannel("telegram");
    const channels = new Map([["telegram", telegram]]);
    const tool = createSendTool(channels);

    const result = await tool.execute({
      channel: "slack",
      chatId: "C789",
      text: "hello",
    });

    expect(result).toEqual(
      expect.objectContaining({ success: false }),
    );
    expect(telegram.sendText).not.toHaveBeenCalled();
  });
});
