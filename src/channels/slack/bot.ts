import { App } from "@slack/bolt";
import type { ChannelAdapter, InboundMessage, MessageHandler, SendResult } from "../types.js";

export interface SlackChannelConfig {
  enabled: boolean;
  botToken: string;
  appToken: string;
  mode?: "socket" | "http";
  allowFrom?: string[];
}

export function createSlackChannel(
  config: SlackChannelConfig,
  onMessage: MessageHandler,
): ChannelAdapter {
  const app = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: config.mode !== "http",
  });

  function handleEvent(event: Record<string, unknown>): void {
    const userId = event.user as string;
    if (config.allowFrom && config.allowFrom.length > 0) {
      if (!config.allowFrom.includes(userId)) return;
    }
    const msg: InboundMessage = {
      channel: "slack",
      chatId: event.channel as string,
      userId,
      username: (event.username as string) ?? undefined,
      text: event.text as string,
      source: "user",
      threadId: (event.thread_ts as string) ?? undefined,
      raw: event,
    };
    onMessage(msg);
  }

  app.event("message", async ({ event }) => {
    handleEvent(event as unknown as Record<string, unknown>);
  });

  app.event("app_mention", async ({ event }) => {
    handleEvent(event as unknown as Record<string, unknown>);
  });

  return {
    id: "slack",
    start: () => app.start(),
    stop: () => app.stop(),
    sendText: async (chatId: string, text: string): Promise<SendResult> => {
      const result = await app.client.chat.postMessage({
        channel: chatId,
        text,
      });
      return { messageId: result.ts as string, success: true };
    },
    editMessage: async (chatId: string, messageId: string | number, text: string): Promise<void> => {
      await app.client.chat.update({
        channel: chatId,
        ts: String(messageId),
        text,
      });
    },
  };
}
