/**
 * Edge case tests for Telegram send/chunking.
 *
 * Covers: unicode splitting, surrogate pairs, whitespace-only text,
 * exact boundary conditions, very long single words, repeated failures.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { splitTextChunks, sendText } from "./send.js";

function createMockBot() {
  return {
    api: {
      sendMessage: vi.fn().mockResolvedValue({ message_id: 42 }),
    },
  } as unknown as Parameters<typeof sendText>[0];
}

describe("splitTextChunks edge cases", () => {
  it("handles text of exactly limit + 1 characters", () => {
    const text = "a".repeat(4001);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(1);
  });

  it("handles single word longer than limit (hard split)", () => {
    const text = "x".repeat(10000);
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
    expect(chunks.join("")).toBe(text);
  });

  it("handles text that is only newlines", () => {
    const text = "\n".repeat(100);
    const chunks = splitTextChunks(text, 4000);
    // After trimStart/trimEnd, chunks may be filtered out
    // This should not crash
    expect(Array.isArray(chunks)).toBe(true);
  });

  it("handles text that is only spaces", () => {
    const text = " ".repeat(5000);
    const chunks = splitTextChunks(text, 4000);
    // Whitespace gets trimmed, likely empty chunks filtered out
    expect(Array.isArray(chunks)).toBe(true);
  });

  it("splits at paragraph break even when near start of text", () => {
    // Paragraph break at 60% of limit — should prefer it
    const part1 = "A".repeat(2500);
    const part2 = "B".repeat(2500);
    const text = part1 + "\n\n" + part2;
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(part1);
  });

  it("does not split text with many short lines unnecessarily", () => {
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i}`);
    const text = lines.join("\n");
    // ~800 chars total — under 4000 limit
    const chunks = splitTextChunks(text, 4000);
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toBe(text);
  });

  it("preserves content integrity across all chunks", () => {
    // Build text with multiple split-friendly boundaries
    const segments = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i}: ${"word ".repeat(100)}`,
    );
    const text = segments.join("\n\n");
    const chunks = splitTextChunks(text, 4000);

    // Verify no content lost (accounting for trim)
    const reconstructed = chunks.join(" "); // Approximate — trimmed whitespace lost
    for (const segment of segments) {
      expect(reconstructed).toContain(segment.trim());
    }
  });

  it("handles emoji in text", () => {
    const emoji = "🔥".repeat(2000); // Each emoji is 2 chars in JS
    const chunks = splitTextChunks(emoji, 4000);
    expect(chunks.length).toBe(1); // 4000 chars fits
  });

  it("handles emoji that would split on surrogate pair boundary", () => {
    const emoji = "🔥".repeat(2001); // 4002 chars — splits at limit
    const chunks = splitTextChunks(emoji, 4000);
    expect(chunks.length).toBe(2);
    // We accept that hard-split may break a surrogate pair —
    // this is a known limitation, just verify no crash
  });

  it("handles CJK text (multi-byte characters)", () => {
    const cjk = "你好世界".repeat(500); // 2000 chars
    const chunks = splitTextChunks(cjk, 4000);
    expect(chunks.length).toBe(1);
  });

  it("handles markdown code blocks spanning chunk boundary", () => {
    const code = "```\n" + "x = 1\n".repeat(800) + "```";
    const chunks = splitTextChunks(code, 4000);
    // Chunks may split inside code block — this is expected behavior
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000);
    }
  });
});

describe("sendText edge cases", () => {
  let bot: ReturnType<typeof createMockBot>;

  beforeEach(() => {
    bot = createMockBot();
  });

  it("returns messageId 0 for empty string", async () => {
    const result = await sendText(bot, "123", "");
    expect(result.messageId).toBe(0);
    expect(result.success).toBe(true);
  });

  it("handles whitespace-only text", async () => {
    const result = await sendText(bot, "123", "   ");
    // After chunking, whitespace-only text may produce empty chunks
    // Should not crash
    expect(result.success).toBe(true);
  });

  it("uses last chunk's messageId when sending multiple chunks", async () => {
    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    let callCount = 0;
    api.sendMessage.mockImplementation(() => {
      callCount++;
      return Promise.resolve({ message_id: 100 + callCount });
    });

    const longText = "word ".repeat(1000);
    const result = await sendText(bot, "123", longText);

    expect(result.messageId).toBeGreaterThan(100);
    expect(callCount).toBeGreaterThan(1);
  });

  it("falls back to plain text per-chunk on markdown error", async () => {
    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    // Alternate: first markdown fails, fallback works, second markdown works
    api.sendMessage
      .mockRejectedValueOnce(new Error("markdown error"))
      .mockResolvedValueOnce({ message_id: 42 });

    const result = await sendText(bot, "123", "Hello *broken");
    expect(result.success).toBe(true);
  });

  it("throws when both markdown and plain text fail", async () => {
    const api = (bot as unknown as { api: { sendMessage: ReturnType<typeof vi.fn> } }).api;
    api.sendMessage.mockRejectedValue(new Error("network down"));

    await expect(sendText(bot, "123", "hello")).rejects.toThrow("network down");
  });
});
