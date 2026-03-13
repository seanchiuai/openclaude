/**
 * Streaming reply helper for progressive message updates.
 *
 * Manages the lifecycle of a streaming message: first send, throttled edits,
 * message splitting at char limits, and graceful error fallback.
 */
import { splitTextChunks } from "./telegram/send.js";

export interface StreamingReplyOpts {
  sendText: (text: string) => Promise<{ messageId: string | number }>;
  editMessage: (messageId: string | number, text: string) => Promise<void>;
  charLimit?: number;
  throttleMs?: number;
}

export interface StreamingReply {
  /** Update with latest accumulated text from an assistant event */
  update(text: string): void;
  /** Show a status indicator (e.g. tool use) */
  status(message: string): void;
  /** Final edit with complete text */
  finalize(finalText: string): Promise<void>;
  /** Whether streaming has failed (caller should fall back to fresh send) */
  failed(): boolean;
}

export function createStreamingReply(opts: StreamingReplyOpts): StreamingReply {
  const charLimit = opts.charLimit ?? 4000;
  const throttleMs = opts.throttleMs ?? 1000;

  let messageId: string | number | null = null;
  let messageIdPromise: Promise<{ messageId: string | number }> | null = null;
  let pendingText = "";
  let lastEditAt = 0;
  let editTimer: ReturnType<typeof setTimeout> | null = null;
  let hasFailed = false;
  let statusSuffix = "";

  function clearTimer(): void {
    if (editTimer !== null) {
      clearTimeout(editTimer);
      editTimer = null;
    }
  }

  async function doEdit(text: string): Promise<void> {
    if (hasFailed || messageId === null) return;
    try {
      await opts.editMessage(messageId, text);
      lastEditAt = Date.now();
    } catch {
      hasFailed = true;
      clearTimer();
    }
  }

  function scheduleEdit(): void {
    if (hasFailed) return;

    const now = Date.now();
    const elapsed = now - lastEditAt;
    const textToSend = pendingText + statusSuffix;

    if (elapsed >= throttleMs) {
      clearTimer();
      doEdit(textToSend);
    } else {
      // Replace any existing timer with one that fires at the throttle boundary
      clearTimer();
      editTimer = setTimeout(() => {
        editTimer = null;
        const currentText = pendingText + statusSuffix;
        doEdit(currentText);
      }, throttleMs - elapsed);
    }
  }

  function update(text: string): void {
    if (hasFailed) return;
    statusSuffix = ""; // Clear status on real text update
    pendingText = text;

    // Handle message splitting: if text exceeds charLimit, split
    if (text.length > charLimit && messageId !== null) {
      const chunks = splitTextChunks(text, charLimit);
      if (chunks.length > 1) {
        // Edit current message with first chunk, then start new message for rest
        const firstChunk = chunks[0];
        const rest = text.slice(firstChunk.length).trimStart();
        doEdit(firstChunk).then(() => {
          // Reset so next update sends a new message
          messageId = null;
          messageIdPromise = null;
          pendingText = rest;
          // Send the overflow as a new message
          sendFirst(rest);
        });
        return;
      }
    }

    if (messageId === null && messageIdPromise === null) {
      // First update: send initial message
      sendFirst(text);
    } else if (messageId !== null) {
      scheduleEdit();
    }
    // If messageIdPromise is pending but not resolved, buffer — next update after resolve will edit
  }

  function sendFirst(text: string): void {
    messageIdPromise = opts.sendText(text).then((result) => {
      messageId = result.messageId;
      messageIdPromise = null;
      // If text has changed since we sent, schedule an edit
      const currentText = pendingText + statusSuffix;
      if (currentText !== text && !hasFailed) {
        scheduleEdit();
      }
      return result;
    }).catch(() => {
      hasFailed = true;
      clearTimer();
      return { messageId: 0 };
    });
  }

  function status(message: string): void {
    if (hasFailed) return;
    statusSuffix = `\n\n_${message}_`;
    if (messageId !== null) {
      scheduleEdit();
    } else if (messageIdPromise === null && pendingText === "") {
      // No message sent yet — send status as first message
      sendFirst(`_${message}_`);
    }
  }

  async function finalize(finalText: string): Promise<void> {
    if (hasFailed) return;
    clearTimer();
    statusSuffix = "";
    pendingText = finalText;

    // Wait for any pending send to resolve
    if (messageIdPromise) {
      await messageIdPromise;
    }

    if (messageId === null || hasFailed) return;

    // Handle splitting for final text
    if (finalText.length > charLimit) {
      const chunks = splitTextChunks(finalText, charLimit);
      // Edit current message with first chunk
      await doEdit(chunks[0]);
      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        if (hasFailed) return;
        try {
          await opts.sendText(chunks[i]);
        } catch {
          hasFailed = true;
          return;
        }
      }
    } else {
      await doEdit(finalText);
    }
  }

  return {
    update,
    status,
    finalize,
    failed: () => hasFailed,
  };
}
