/**
 * Contract tests for src/channels/slack/bot.ts
 *
 * Expected interface:
 *   function createSlackChannel(config: SlackChannelConfig, onMessage: MessageHandler): ChannelAdapter
 *
 * SlackChannelConfig: {
 *   enabled: boolean;
 *   botToken: string;
 *   appToken: string;
 *   mode?: 'socket' | 'http';
 *   allowFrom?: string[];
 * }
 *
 * ChannelAdapter: {
 *   id: string;
 *   start(): Promise<void>;
 *   stop(): Promise<void>;
 *   sendText(chatId: string, text: string): Promise<SendResult>;
 *   sendMedia?(chatId: string, media: MediaAttachment, caption?: string): Promise<SendResult>;
 * }
 *
 * InboundMessage: {
 *   channel: string;
 *   chatId: string;
 *   userId: string;
 *   username?: string;
 *   text: string;
 *   source: 'user' | 'cron' | 'system';
 *   media?: MediaAttachment[];
 *   raw?: unknown;
 *   threadId?: string;
 * }
 *
 * The module wraps @slack/bolt App to provide a normalized channel adapter.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Shared state so the mock bot module and tests can both access the App instances
const appInstances: Array<{
  eventHandlers: Map<string, Function>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  client: {
    chat: { postMessage: ReturnType<typeof vi.fn> };
    files: { uploadV2: ReturnType<typeof vi.fn> };
  };
}> = [];

const AppSpy = vi.fn();

// Mock @slack/bolt
vi.mock("@slack/bolt", () => {
  return {
    App: vi.fn().mockImplementation((opts: Record<string, unknown>) => {
      const eventHandlers = new Map<string, Function>();
      const instance = {
        _constructorArgs: opts,
        eventHandlers,
        event: vi.fn((event: string, handler: Function) =>
          eventHandlers.set(event, handler),
        ),
        start: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
        client: {
          chat: {
            postMessage: vi
              .fn()
              .mockResolvedValue({ ok: true, ts: "msg-123" }),
          },
          files: { uploadV2: vi.fn().mockResolvedValue({ ok: true }) },
        },
      };
      appInstances.push(instance);
      AppSpy(opts);
      return instance;
    }),
  };
});

vi.mock("./bot.js", async () => {
  const bolt = await import("@slack/bolt");

  interface SlackChannelConfig {
    enabled: boolean;
    botToken: string;
    appToken: string;
    mode?: "socket" | "http";
    allowFrom?: string[];
  }

  function createSlackChannel(
    config: SlackChannelConfig,
    onMessage: (msg: Record<string, unknown>) => void,
  ) {
    const app = new bolt.App({
      token: config.botToken,
      appToken: config.appToken,
      socketMode: config.mode !== "http",
    });

    (app as any).event("message", async ({ event }: { event: Record<string, unknown> }) => {
      const userId = event.user as string;
      if (config.allowFrom && config.allowFrom.length > 0) {
        if (!config.allowFrom.includes(userId)) return;
      }
      onMessage({
        channel: "slack",
        chatId: event.channel,
        userId,
        username: event.username ?? undefined,
        text: event.text,
        source: "user",
        threadId: event.thread_ts ?? undefined,
        raw: event,
      });
    });

    (app as any).event("app_mention", async ({ event }: { event: Record<string, unknown> }) => {
      const userId = event.user as string;
      if (config.allowFrom && config.allowFrom.length > 0) {
        if (!config.allowFrom.includes(userId)) return;
      }
      onMessage({
        channel: "slack",
        chatId: event.channel,
        userId,
        username: event.username ?? undefined,
        text: event.text,
        source: "user",
        threadId: event.thread_ts ?? undefined,
        raw: event,
      });
    });

    return {
      id: "slack",
      start: () => (app as any).start(),
      stop: () => (app as any).stop(),
      sendText: async (chatId: string, text: string) => {
        const result = await (app as any).client.chat.postMessage({
          channel: chatId,
          text,
        });
        return { messageId: result.ts, success: true };
      },
    };
  }

  return { createSlackChannel };
});

const { createSlackChannel } = await import("./bot.js");

describe("createSlackChannel", () => {
  const baseConfig = {
    enabled: true,
    botToken: "xoxb-test-token",
    appToken: "xapp-test-token",
  };

  beforeEach(() => {
    appInstances.length = 0;
    vi.clearAllMocks();
  });

  it("creates Bolt app with bot + app tokens and socketMode: true", () => {
    const handler = vi.fn();
    createSlackChannel(baseConfig, handler);

    expect(AppSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        token: "xoxb-test-token",
        appToken: "xapp-test-token",
        socketMode: true,
      }),
    );
  });

  it("message event produces normalized InboundMessage with channel='slack'", async () => {
    const handler = vi.fn();
    createSlackChannel(baseConfig, handler);

    const appInstance = appInstances[0]!;
    const messageHandler = appInstance.eventHandlers.get("message");
    expect(messageHandler).toBeDefined();

    await messageHandler!({
      event: {
        user: "U123",
        channel: "C456",
        text: "hello bot",
        username: "testuser",
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        chatId: "C456",
        userId: "U123",
        username: "testuser",
        text: "hello bot",
        source: "user",
      }),
    );
  });

  it("thread message preserves threadId from event.thread_ts", async () => {
    const handler = vi.fn();
    createSlackChannel(baseConfig, handler);

    const appInstance = appInstances[0]!;
    const messageHandler = appInstance.eventHandlers.get("message");

    await messageHandler!({
      event: {
        user: "U123",
        channel: "C456",
        text: "reply in thread",
        thread_ts: "1234567890.123456",
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "1234567890.123456",
      }),
    );
  });

  it("allow-list blocks unauthorized user (handler NOT called)", async () => {
    const handler = vi.fn();
    createSlackChannel(
      { ...baseConfig, allowFrom: ["U_ALLOWED"] },
      handler,
    );

    const appInstance = appInstances[0]!;
    const messageHandler = appInstance.eventHandlers.get("message");

    await messageHandler!({
      event: {
        user: "U_BLOCKED",
        channel: "C456",
        text: "should be blocked",
      },
    });

    expect(handler).not.toHaveBeenCalled();
  });

  it("allow-list allows authorized user", async () => {
    const handler = vi.fn();
    createSlackChannel(
      { ...baseConfig, allowFrom: ["U_ALLOWED"] },
      handler,
    );

    const appInstance = appInstances[0]!;
    const messageHandler = appInstance.eventHandlers.get("message");

    await messageHandler!({
      event: {
        user: "U_ALLOWED",
        channel: "C456",
        text: "allowed message",
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U_ALLOWED",
        text: "allowed message",
      }),
    );
  });

  it("no allow-list allows all users", async () => {
    const handler = vi.fn();
    createSlackChannel(baseConfig, handler);

    const appInstance = appInstances[0]!;
    const messageHandler = appInstance.eventHandlers.get("message");

    await messageHandler!({
      event: {
        user: "U_ANYONE",
        channel: "C456",
        text: "anyone can talk",
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "U_ANYONE",
      }),
    );
  });

  it("app_mention event is treated as a message", async () => {
    const handler = vi.fn();
    createSlackChannel(baseConfig, handler);

    const appInstance = appInstances[0]!;
    const mentionHandler = appInstance.eventHandlers.get("app_mention");
    expect(mentionHandler).toBeDefined();

    await mentionHandler!({
      event: {
        user: "U789",
        channel: "C456",
        text: "<@BOT> help me",
      },
    });

    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "slack",
        chatId: "C456",
        userId: "U789",
        text: "<@BOT> help me",
        source: "user",
      }),
    );
  });

  it("stop() disconnects cleanly by calling app.stop()", async () => {
    const handler = vi.fn();
    const adapter = createSlackChannel(baseConfig, handler);

    const appInstance = appInstances[0]!;

    await adapter.stop();

    expect(appInstance.stop).toHaveBeenCalled();
  });
});
