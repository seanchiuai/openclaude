/**
 * Telegram message sending with chunking.
 * Extracted and simplified from OpenClaw's telegram/send.ts.
 *
 * Handles the 4096 char Telegram limit by splitting into chunks.
 */
import type { Bot } from "grammy";
import type { SendResult } from "../types.js";

const TELEGRAM_TEXT_LIMIT = 4096;
const CHUNK_LIMIT = 4000; // Safety margin

export async function sendText(
  bot: Bot,
  chatId: string,
  text: string,
): Promise<SendResult> {
  const chunks = splitTextChunks(text, CHUNK_LIMIT);
  let lastMessageId: number | undefined;

  for (const chunk of chunks) {
    try {
      const msg = await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "Markdown",
      });
      lastMessageId = msg.message_id;
    } catch {
      // Fallback: try without parse_mode if Markdown fails
      const msg = await bot.api.sendMessage(chatId, chunk);
      lastMessageId = msg.message_id;
    }
  }

  return {
    messageId: lastMessageId ?? 0,
    success: true,
  };
}

export async function sendMedia(
  bot: Bot,
  chatId: string,
  type: "photo" | "document" | "audio" | "video",
  fileIdOrUrl: string,
  caption?: string,
): Promise<SendResult> {
  let messageId: number;

  switch (type) {
    case "photo": {
      const msg = await bot.api.sendPhoto(chatId, fileIdOrUrl, { caption });
      messageId = msg.message_id;
      break;
    }
    case "document": {
      const msg = await bot.api.sendDocument(chatId, fileIdOrUrl, { caption });
      messageId = msg.message_id;
      break;
    }
    case "audio": {
      const msg = await bot.api.sendAudio(chatId, fileIdOrUrl, { caption });
      messageId = msg.message_id;
      break;
    }
    case "video": {
      const msg = await bot.api.sendVideo(chatId, fileIdOrUrl, { caption });
      messageId = msg.message_id;
      break;
    }
  }

  return { messageId, success: true };
}

/**
 * Split text into chunks respecting the Telegram character limit.
 * Tries to split on newlines, then sentences, then words.
 * Extracted from OpenClaw's splitTelegramPlainTextChunks.
 */
export function splitTextChunks(text: string, limit = CHUNK_LIMIT): string[] {
  if (text.length === 0) return [];
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Find a good split point
    let splitAt = findSplitPoint(remaining, limit);
    chunks.push(remaining.slice(0, splitAt).trimEnd());
    remaining = remaining.slice(splitAt).trimStart();
  }

  return chunks.filter((c) => c.length > 0);
}

export async function reactMessage(
  bot: Bot,
  chatId: string,
  messageId: number,
  emoji: string,
  opts?: { remove?: boolean },
): Promise<{ ok: true } | { ok: false; warning: string }> {
  const reactions = opts?.remove
    ? []
    : [{ type: "emoji" as const, emoji: emoji.trim() }];

  try {
    await bot.api.setMessageReaction(chatId, messageId, reactions);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("REACTION_INVALID")) {
      return { ok: false, warning: msg };
    }
    throw err;
  }
}

function findSplitPoint(text: string, limit: number): number {
  // Try to split at a double newline (paragraph break)
  const doubleNewline = text.lastIndexOf("\n\n", limit);
  if (doubleNewline > limit * 0.5) return doubleNewline + 1;

  // Try to split at a single newline
  const newline = text.lastIndexOf("\n", limit);
  if (newline > limit * 0.3) return newline + 1;

  // Try to split at a sentence boundary
  const sentence = text.lastIndexOf(". ", limit);
  if (sentence > limit * 0.3) return sentence + 2;

  // Try to split at a space
  const space = text.lastIndexOf(" ", limit);
  if (space > limit * 0.2) return space + 1;

  // Hard split at limit
  return limit;
}
