import { describe, it, expect, vi } from "vitest";
import { createStreamingReply } from "../streaming.js";

describe("streaming reply integration", () => {
  it("update() sends first message then edits", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("Hello world");
    expect(sendText).toHaveBeenCalledWith("Hello world");
  });

  it("status() sends italic status text", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.status("[Using tool: Read]");
    expect(sendText).toHaveBeenCalledWith("_[Using tool: Read]_");
  });

  it("finalize() edits with complete text", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("partial");
    await vi.waitFor(() => expect(sendText).toHaveBeenCalled());
    await reply.finalize("complete response");
    expect(editMessage).toHaveBeenCalledWith(42, "complete response");
  });

  it("failed() returns true after edit error", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockRejectedValue(new Error("edit failed"));
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("partial");
    await vi.waitFor(() => expect(sendText).toHaveBeenCalled());
    reply.update("updated");
    await vi.waitFor(() => expect(reply.failed()).toBe(true));
  });

  it("accumulates text across multiple updates", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("First paragraph");
    reply.update("First paragraph\n\nSecond paragraph");
    expect(sendText).toHaveBeenCalledWith("First paragraph");
  });
});
