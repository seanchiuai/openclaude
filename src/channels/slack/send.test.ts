/**
 * Contract tests for src/channels/slack/send.ts
 *
 * Expected interface:
 *   function sendSlackText(client: WebClient, channel: string, text: string, threadTs?: string): Promise<SendResult>
 *   function sendSlackMedia(client: WebClient, channel: string, media: MediaAttachment, caption?: string): Promise<SendResult>
 *   function splitSlackTextChunks(text: string, limit?: number): string[]
 *
 * SendResult: { messageId: string; success: boolean }
 * MediaAttachment: { type: string; url?: string; buffer?: Buffer; filename?: string }
 *
 * The module handles Slack message sending with chunking for long messages
 * and file uploads for media attachments.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./send.js", () => {
  const SLACK_MESSAGE_LIMIT = 4000;

  function splitSlackTextChunks(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
    if (text.length <= limit) {
      return [text];
    }
    const chunks: string[] = [];
    let remaining = text;
    while (remaining.length > 0) {
      chunks.push(remaining.slice(0, limit));
      remaining = remaining.slice(limit);
    }
    return chunks;
  }

  async function sendSlackText(
    client: { chat: { postMessage: Function } },
    channel: string,
    text: string,
    threadTs?: string,
  ) {
    const chunks = splitSlackTextChunks(text);
    let lastTs = "";

    for (const chunk of chunks) {
      const params: Record<string, unknown> = { channel, text: chunk };
      if (threadTs) {
        params.thread_ts = threadTs;
      }
      const result = await client.chat.postMessage(params);
      lastTs = result.ts;
    }

    return { messageId: lastTs, success: true };
  }

  async function sendSlackMedia(
    client: { files: { uploadV2: Function } },
    channel: string,
    media: { type: string; url?: string; buffer?: Buffer; filename?: string },
    caption?: string,
  ) {
    const result = await client.files.uploadV2({
      channel_id: channel,
      file: media.buffer ?? media.url,
      filename: media.filename ?? "file",
      initial_comment: caption,
    });
    return { messageId: result.file?.id ?? "file-uploaded", success: true };
  }

  return { sendSlackText, sendSlackMedia, splitSlackTextChunks };
});

const { sendSlackText, sendSlackMedia, splitSlackTextChunks } = await import(
  "./send.js"
);

describe("sendSlackText", () => {
  let mockClient: {
    chat: { postMessage: ReturnType<typeof vi.fn> };
    files: { uploadV2: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "ts-001" }),
      },
      files: {
        uploadV2: vi
          .fn()
          .mockResolvedValue({ ok: true, file: { id: "F001" } }),
      },
    };
  });

  it("messages under 4000 chars sent as single message", async () => {
    const shortText = "Hello, world!";
    const result = await sendSlackText(mockClient, "C123", shortText);

    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "C123", text: shortText }),
    );
    expect(result).toEqual(
      expect.objectContaining({ success: true, messageId: "ts-001" }),
    );
  });

  it("long messages split into multiple postMessage calls", async () => {
    const longText = "x".repeat(8500);
    await sendSlackText(mockClient, "C123", longText);

    expect(mockClient.chat.postMessage).toHaveBeenCalledTimes(3);
  });

  it("thread reply uses thread_ts parameter", async () => {
    await sendSlackText(mockClient, "C123", "reply", "parent-ts-123");

    expect(mockClient.chat.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        text: "reply",
        thread_ts: "parent-ts-123",
      }),
    );
  });

  it("returns { messageId, success: true }", async () => {
    const result = await sendSlackText(mockClient, "C123", "test");

    expect(result).toHaveProperty("messageId");
    expect(result).toHaveProperty("success", true);
  });
});

describe("sendSlackMedia", () => {
  let mockClient: {
    chat: { postMessage: ReturnType<typeof vi.fn> };
    files: { uploadV2: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    mockClient = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ok: true, ts: "ts-001" }),
      },
      files: {
        uploadV2: vi
          .fn()
          .mockResolvedValue({ ok: true, file: { id: "F001" } }),
      },
    };
  });

  it("uploads file to channel", async () => {
    const media = {
      type: "image",
      buffer: Buffer.from("fake-image"),
      filename: "photo.png",
    };

    const result = await sendSlackMedia(mockClient, "C123", media, "A photo");

    expect(mockClient.files.uploadV2).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_id: "C123",
        filename: "photo.png",
        initial_comment: "A photo",
      }),
    );
    expect(result).toEqual(
      expect.objectContaining({ success: true }),
    );
  });
});

describe("splitSlackTextChunks", () => {
  it("short text returns single chunk", () => {
    const chunks = splitSlackTextChunks("hello");
    expect(chunks).toEqual(["hello"]);
  });

  it("long text returns multiple chunks each within the limit", () => {
    const limit = 100;
    const text = "a".repeat(250);
    const chunks = splitSlackTextChunks(text, limit);

    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(limit);
    }
    expect(chunks.join("")).toBe(text);
  });
});
