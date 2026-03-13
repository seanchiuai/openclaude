/**
 * Contract: Telegram Message Sending with Chunking
 *
 * sendText(bot, chatId, text) sends text messages, chunking at CHUNK_LIMIT (4000).
 * - Messages under limit sent as single message
 * - Long messages split at paragraph breaks, then newlines, then sentences, then spaces
 * - Each chunk <= limit
 * - Falls back to plain text if Markdown parse fails
 * - Returns { messageId, success: true }
 *
 * sendMedia(bot, chatId, type, fileIdOrUrl, caption?) sends media messages.
 * - Supports photo, document, audio, video types
 * - Returns { messageId, success: true }
 *
 * splitTextChunks(text, limit) splits text respecting boundaries.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitTextChunks, sendText, sendMedia } from "./send.js";

// --- sendText and sendMedia tests with mock bot ---

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
      sendPhoto: vi.fn().mockResolvedValue({ message_id: 50 }),
      sendDocument: vi.fn().mockResolvedValue({ message_id: 51 }),
      sendAudio: vi.fn().mockResolvedValue({ message_id: 52 }),
      sendVideo: vi.fn().mockResolvedValue({ message_id: 53 }),
    },
  } as unknown as Parameters<typeof sendText>[0];
}

describe("sendText", () => {
  let bot: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    bot = createMockBot();
  });

  it("sends a short message as a single api.sendMessage call", async () => {
    const result = await sendText(bot, "123", "Hello world");

    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendMessage).toHaveBeenCalledOnce();
    expect(api.sendMessage).toHaveBeenCalledWith("123", "Hello world", {
      parse_mode: "Markdown",
    });
    expect(result).toEqual({ messageId: 42, success: true });
  });

  it("sends a long message as multiple api.sendMessage calls", async () => {
    const longText = "word ".repeat(1000); // ~5000 chars, exceeds 4000 limit

    await sendText(bot, "456", longText);

    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendMessage.mock.calls.length).toBeGreaterThan(1);
  });

  it("returns messageId 0 and success true for empty text", async () => {
    const result = await sendText(bot, "123", "");

    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendMessage).not.toHaveBeenCalled();
    expect(result).toEqual({ messageId: 0, success: true });
  });

  it("throws when both markdown and plain text fail", async () => {
    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    api.sendMessage.mockRejectedValue(new Error("network error"));

    await expect(sendText(bot, "789", "some text")).rejects.toThrow("network error");
  });

  it("falls back to plain text if Markdown parse fails", async () => {
    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    // First call (with Markdown) rejects, second call (plain) resolves
    api.sendMessage
      .mockRejectedValueOnce(new Error("parse error"))
      .mockResolvedValueOnce({ message_id: 99 });

    const result = await sendText(bot, "789", "Some *broken markdown");

    expect(api.sendMessage).toHaveBeenCalledTimes(2);
    // Second call should not have parse_mode
    expect(api.sendMessage.mock.calls[1]).toEqual(["789", "Some *broken markdown"]);
    expect(result).toEqual({ messageId: 99, success: true });
  });
});

describe("sendMedia", () => {
  let bot: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    bot = createMockBot();
  });

  it("photo type calls bot.api.sendPhoto", async () => {
    await sendMedia(bot, "123", "photo", "photo_file_id", "a caption");

    const api = (bot as unknown as { api: { sendPhoto: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendPhoto).toHaveBeenCalledWith("123", "photo_file_id", {
      caption: "a caption",
    });
  });

  it("document type calls bot.api.sendDocument", async () => {
    await sendMedia(bot, "123", "document", "doc_file_id");

    const api = (bot as unknown as { api: { sendDocument: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendDocument).toHaveBeenCalledWith("123", "doc_file_id", {
      caption: undefined,
    });
  });

  it("returns messageId and success", async () => {
    const result = await sendMedia(bot, "123", "photo", "file_id");

    expect(result).toEqual({ messageId: 50, success: true });
  });

  it("audio type calls bot.api.sendAudio", async () => {
    await sendMedia(bot, "123", "audio", "audio_file_id", "audio caption");

    const api = (bot as unknown as { api: { sendAudio: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendAudio).toHaveBeenCalledWith("123", "audio_file_id", {
      caption: "audio caption",
    });
  });

  it("video type calls bot.api.sendVideo", async () => {
    await sendMedia(bot, "123", "video", "video_file_id", "video caption");

    const api = (bot as unknown as { api: { sendVideo: ReturnType<typeof vi.fn> } }).api;
    expect(api.sendVideo).toHaveBeenCalledWith("123", "video_file_id", {
      caption: "video caption",
    });
  });
});

// --- splitTextChunks tests (existing, preserved) ---

describe("splitTextChunks", () => {
  it("returns single chunk for short text", () => {
    const chunks = splitTextChunks("Hello world", 4000);
    expect(chunks).toEqual(["Hello world"]);
  });

  it("splits long text into multiple chunks", () => {
    const text = "a".repeat(5000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBeLessThanOrEqual(4000);
    expect(chunks.join("")).toBe(text);
  });

  it("prefers splitting at paragraph breaks", () => {
    const text = "A".repeat(3000) + "\n\n" + "B".repeat(2000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("A".repeat(3000));
    expect(chunks[1]).toBe("B".repeat(2000));
  });

  it("prefers splitting at newlines", () => {
    const text = "A".repeat(3000) + "\n" + "B".repeat(2000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe("A".repeat(3000));
    expect(chunks[1]).toBe("B".repeat(2000));
  });

  it("prefers splitting at sentence boundaries", () => {
    const text = "A".repeat(3000) + ". " + "B".repeat(2000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
  });

  it("handles empty text", () => {
    const chunks = splitTextChunks("", 4000);
    expect(chunks).toEqual([]);
  });

  it("handles text exactly at limit", () => {
    const text = "x".repeat(4000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks).toEqual([text]);
  });

  it("handles very long text needing many chunks", () => {
    const text = "word ".repeat(5000); // ~25000 chars
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBeGreaterThan(5);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});
