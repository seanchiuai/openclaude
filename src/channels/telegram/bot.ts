/**
 * Telegram bot setup and message handling.
 * Extracted and simplified from OpenClaw's telegram/bot.ts and monitor.ts.
 *
 * Creates a grammY bot with long-polling, auto-restart with exponential backoff,
 * and allow-list based access control.
 */
import { Bot } from "grammy";
import { apiThrottler } from "@grammyjs/transformer-throttler";
import { createLogger } from "../../logging/logger.js";
import { sendText, sendMedia, reactMessage } from "./send.js";
import { createTypingCallbacks } from "../typing.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { createStatusReactionController } from "../status-reactions.js";
import {
  resolveTelegramStatusReactionEmojis,
  buildTelegramStatusReactionVariants,
  resolveTelegramReactionVariant,
} from "./status-reaction-variants.js";
import { createStreamingReply } from "../streaming.js";
import type {
  ChannelAdapter,
  InboundMessage,
  MediaAttachment,
  MessageHandler,
  SendResult,
} from "../types.js";
import type { OnStreamEvent, StreamEvent } from "../../engine/types.js";
import type { TelegramChannelConfig } from "../../config/types.js";

/** Backoff policy extracted from OpenClaw's polling-session.ts */
const BACKOFF = {
  initialMs: 2000,
  maxMs: 30_000,
  factor: 1.8,
  jitter: 0.25,
};

const log = createLogger("telegram");

export function createTelegramChannel(
  config: TelegramChannelConfig,
  onMessage: MessageHandler,
): ChannelAdapter {
  const bot = new Bot(config.botToken);
  const allowSet = config.allowFrom
    ? new Set(config.allowFrom.map(String))
    : null;
  let running = false;
  let restartAttempts = 0;
  let abortController: AbortController | null = null;

  // Apply API throttler
  bot.api.config.use(apiThrottler());

  // Global 401 backoff handler (shared across all chats)
  const chatActionHandler = createTelegramSendChatActionHandler({
    sendChatActionFn: (chatId, action) => bot.api.sendChatAction(String(chatId), action),
    logger: (msg) => log.warn(msg),
  });

  // Resolve emoji variants once at startup
  const emojis = resolveTelegramStatusReactionEmojis({ initialEmoji: "👀" });
  const variantsByEmoji = buildTelegramStatusReactionVariants(emojis);

  function shouldSkipMessage(ctx: {
    chat: { type: string };
    message: { text?: string; caption?: string; reply_to_message?: { from?: { id: number } } };
  }): boolean {
    if (ctx.chat.type === "private") return false;
    if (config.requireMention === false) return false;

    const text = ctx.message.text ?? ctx.message.caption ?? "";
    const username = bot.botInfo?.username;
    if (username && text.toLowerCase().includes(`@${username.toLowerCase()}`)) {
      return false;
    }
    if (ctx.message.reply_to_message?.from?.id === bot.botInfo?.id) {
      return false;
    }
    return true;
  }

  async function withTypingAndReactions(
    chatId: string,
    messageId: number,
    handler: (onEvent?: OnStreamEvent) => Promise<string>,
  ): Promise<void> {
    const reactionController = createStatusReactionController({
      enabled: true,
      adapter: {
        setReaction: async (emoji) => {
          const resolved = resolveTelegramReactionVariant({
            requestedEmoji: emoji,
            variantsByRequestedEmoji: variantsByEmoji,
          });
          if (resolved) {
            await reactMessage(bot, chatId, messageId, resolved);
          }
        },
      },
      initialEmoji: "👀",
      emojis,
    });
    reactionController.setQueued();

    const typing = createTypingCallbacks({
      start: () => chatActionHandler.sendChatAction(chatId, "typing"),
      onStartError: (err) => log.warn("typing error", { error: err instanceof Error ? err.message : String(err) }),
      maxDurationMs: 300_000,
    });
    await typing.onReplyStart();

    const streamingReply = createStreamingReply({
      sendText: async (text) => {
        const result = await sendText(bot, chatId, text);
        return { messageId: result.messageId };
      },
      editMessage: (msgId, text) => editMessageText(chatId, msgId, text),
    });

    let accumulatedText = "";
    const onEvent: OnStreamEvent = (event: StreamEvent) => {
      if (event.type === "text") {
        accumulatedText += (accumulatedText ? "\n\n" : "") + event.text;
        streamingReply.update(accumulatedText);
      } else if (event.type === "status") {
        streamingReply.status(event.message);
        const toolMatch = event.message.match(/\[Using tool: (.+)\]/);
        if (toolMatch) {
          reactionController.setTool(toolMatch[1]);
        }
      }
    };

    try {
      const response = await handler(onEvent);
      typing.onIdle?.();
      await reactionController.setDone();
      if (response) {
        if (accumulatedText && !streamingReply.failed()) {
          await streamingReply.finalize(response);
        } else {
          await sendText(bot, chatId, response);
        }
      }
    } catch (err) {
      typing.onCleanup?.();
      await reactionController.setError();
      throw err;
    }
  }

  // Message handler
  bot.on("message:text", async (ctx) => {
    const userId = String(ctx.from.id);

    // Allow-list check
    if (allowSet && !allowSet.has(userId)) {
      return; // Silently ignore unauthorized users
    }

    if (shouldSkipMessage(ctx)) return;

    const message: InboundMessage = {
      channel: "telegram",
      chatId: String(ctx.chat.id),
      userId,
      username:
        ctx.from.username ?? ctx.from.first_name ?? String(ctx.from.id),
      text: ctx.message.text,
      source: "user",
      raw: ctx,
    };

    // /stop must bypass the typing wrapper — it needs to execute instantly
    // even if a previous message handler is still running.
    // Fire-and-forget all handlers so grammY can dispatch the next update
    // without waiting for Claude to finish.
    const isAbort = /^\/stop(?:@\S+)?(?:\s|$)/i.test(ctx.message.text);
    if (isAbort) {
      try {
        const response = await onMessage(message);
        if (response) await sendText(bot, String(ctx.chat.id), response);
      } catch (err) {
        log.error("/stop error", { error: err instanceof Error ? err.message : String(err) });
      }
      return;
    }

    // Fire-and-forget: don't block grammY's update loop so /stop can
    // be dispatched while a long-running task is in progress.
    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
      log.error("handler error", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // Photo handler
  bot.on("message:photo", async (ctx) => {
    const userId = String(ctx.from.id);
    if (allowSet && !allowSet.has(userId)) return;
    if (shouldSkipMessage(ctx)) return;

    const photo = ctx.message.photo;
    const largest = photo[photo.length - 1];

    const message: InboundMessage = {
      channel: "telegram",
      chatId: String(ctx.chat.id),
      userId,
      username:
        ctx.from.username ?? ctx.from.first_name ?? String(ctx.from.id),
      text: ctx.message.caption ?? "",
      source: "user",
      media: [
        {
          type: "photo",
          fileId: largest.file_id,
        },
      ],
      raw: ctx,
    };

    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
      log.error("handler error", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  // Document handler
  bot.on("message:document", async (ctx) => {
    const userId = String(ctx.from.id);
    if (allowSet && !allowSet.has(userId)) return;
    if (shouldSkipMessage(ctx)) return;

    const doc = ctx.message.document;

    const message: InboundMessage = {
      channel: "telegram",
      chatId: String(ctx.chat.id),
      userId,
      username:
        ctx.from.username ?? ctx.from.first_name ?? String(ctx.from.id),
      text: ctx.message.caption ?? "",
      source: "user",
      media: [
        {
          type: "document",
          fileId: doc.file_id,
          mimeType: doc.mime_type,
          fileName: doc.file_name,
        },
      ],
      raw: ctx,
    };

    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
      log.error("handler error", { error: err instanceof Error ? err.message : String(err) });
    });
  });

  async function startPolling(): Promise<void> {
    running = true;
    restartAttempts = 0;
    abortController = new AbortController();

    while (running) {
      try {
        await bot.start({
          onStart: () => {
            restartAttempts = 0;
          },
          drop_pending_updates: restartAttempts === 0,
        });
        // bot.start() only returns when stopped gracefully
        break;
      } catch (err) {
        if (!running) break;

        restartAttempts++;
        const delay = computeBackoff(restartAttempts);
        const errMsg =
          err instanceof Error ? err.message : String(err);
        log.error(`Polling error (attempt ${restartAttempts}): ${errMsg}. Retrying in ${delay}ms`);

        await sleep(delay, abortController.signal);
      }
    }
  }

  async function start(): Promise<void> {
    startPolling().catch((err) => {
      log.fatal("Fatal polling error", { error: err instanceof Error ? err.message : String(err) });
    });
  }

  async function stop(): Promise<void> {
    running = false;
    abortController?.abort();
    await bot.stop();
  }

  async function sendTextMessage(
    chatId: string,
    text: string,
  ): Promise<SendResult> {
    return sendText(bot, chatId, text);
  }

  async function sendMediaMessage(
    chatId: string,
    media: MediaAttachment,
    caption?: string,
  ): Promise<SendResult> {
    const fileRef = media.fileId ?? media.url;
    if (!fileRef) {
      return { messageId: 0, success: false };
    }
    return sendMedia(bot, chatId, media.type, fileRef, caption);
  }

  async function editMessageText(
    chatId: string,
    messageId: string | number,
    text: string,
  ): Promise<void> {
    try {
      await bot.api.editMessageText(chatId, Number(messageId), text, {
        parse_mode: "Markdown",
      });
    } catch {
      // Retry without parse_mode if Markdown fails
      await bot.api.editMessageText(chatId, Number(messageId), text);
    }
  }

  return {
    id: "telegram",
    start,
    stop,
    sendText: sendTextMessage,
    editMessage: editMessageText,
    sendMedia: sendMediaMessage,
  };
}

function computeBackoff(attempt: number): number {
  const base = Math.min(
    BACKOFF.initialMs * Math.pow(BACKOFF.factor, attempt - 1),
    BACKOFF.maxMs,
  );
  const jitter = base * BACKOFF.jitter * Math.random();
  return Math.round(base + jitter);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Aborted"));
      },
      { once: true },
    );
  });
}
