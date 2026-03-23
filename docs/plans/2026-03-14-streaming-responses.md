# Streaming Responses (Edit-in-Place) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Wire the existing `StreamingReply` infrastructure to channel handlers so users see incremental text updates during long-running agent tasks, matching OpenClaw's edit-in-place UX pattern.

**Architecture:** The plumbing exists — `spawn.ts` fires `onEvent` with text/status events, `pool.submit()` accepts `onEvent`, `router()` accepts `onProgress`, and `streaming.ts` provides throttled edit-in-place logic. We need to: (1) change `MessageHandler` to accept an `onEvent` callback, (2) create a `StreamingReply` in the Telegram handler and forward events to it, (3) use `finalize()` instead of `sendText()` for the final response, (4) fall back to `sendText()` if streaming fails. The Slack inline handler in `lifecycle.ts` gets the same treatment.

**Tech Stack:** Existing `streaming.ts`, grammY `editMessageText`, vitest

**Key design decisions (matching OpenClaw):**
- No placeholder message — wait for first real text, then send+edit
- 1000ms throttle between edits (already the default in `streaming.ts`)
- `StreamingReply` accumulates text; OpenClaude's `stream-json` delivers assistant blocks (not individual tokens), so no coalescing layer needed
- Status events (tool use) shown as italic suffix on the streaming message
- If streaming edits fail (API error), fall back gracefully to single `sendText()` at end

---

### Task 1: Extend `MessageHandler` type to accept `onEvent`

**Files:**
- Modify: `src/channels/types.ts`

**Step 1: Write the type change**

In `src/channels/types.ts`, change `MessageHandler` to accept an optional `onEvent` callback:

```typescript
import type { OnStreamEvent } from "../engine/types.js";

/** Returns the response text to send back to the user. */
export type MessageHandler = (message: InboundMessage, onEvent?: OnStreamEvent) => Promise<string>;
```

**Step 2: Run full test suite to verify nothing breaks**

Run: `pnpm test`
Expected: PASS — adding an optional param to a type alias is backwards-compatible. All existing callers pass 0 or 1 args, both still valid.

**Step 3: Commit**

```bash
git add src/channels/types.ts
git commit -m "feat(channels): extend MessageHandler to accept onEvent callback"
```

---

### Task 2: Wire streaming into Telegram `withTypingAndReactions`

**Files:**
- Modify: `src/channels/telegram/bot.ts`
- Test: `src/channels/telegram/bot.test.ts` (new test file)

**Step 1: Write the failing test**

Create `src/channels/telegram/bot-streaming.test.ts`:

```typescript
import { describe, it, expect, vi } from "vitest";
import { createStreamingReply } from "../streaming.js";
import type { StreamEvent } from "../../engine/types.js";

describe("streaming reply integration", () => {
  it("update() is called when onEvent fires with text", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("Hello world");

    expect(sendText).toHaveBeenCalledWith("Hello world");
  });

  it("status() appends italic suffix", () => {
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
    // Wait for sendText promise to resolve so messageId is set
    await vi.waitFor(() => expect(sendText).toHaveBeenCalled());

    await reply.finalize("complete response");

    expect(editMessage).toHaveBeenCalledWith(42, "complete response");
  });

  it("failed() returns true after edit error, enabling sendText fallback", async () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockRejectedValue(new Error("edit failed"));
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("partial");
    await vi.waitFor(() => expect(sendText).toHaveBeenCalled());

    // Force an edit that will fail
    reply.update("updated text");
    // Give the edit time to fire and fail
    await vi.waitFor(() => expect(reply.failed()).toBe(true));
  });
});
```

**Step 2: Run test to verify it passes** (these test the existing `streaming.ts`, not new code)

Run: `pnpm vitest run src/channels/telegram/bot-streaming.test.ts`
Expected: PASS — verifying the streaming infrastructure works as expected

**Step 3: Modify `withTypingAndReactions` in `bot.ts`**

The key change: instead of calling `onMessage(message)` and then `sendText()` with the result, create a `StreamingReply`, pass an `onEvent` callback to `onMessage`, and use `finalize()` at the end.

In `src/channels/telegram/bot.ts`, add imports:

```typescript
import { createStreamingReply } from "../streaming.js";
import type { OnStreamEvent, StreamEvent } from "../../engine/types.js";
```

Replace the `withTypingAndReactions` function (lines 82-124):

```typescript
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

    // Create streaming reply for edit-in-place updates
    const streamingReply = createStreamingReply({
      sendText: async (text) => {
        const result = await sendText(bot, chatId, text);
        return { messageId: result.messageId };
      },
      editMessage: (msgId, text) => editMessageText(chatId, msgId, text),
    });

    // Build onEvent callback that forwards to streaming reply + reaction controller
    const onEvent: OnStreamEvent = (event: StreamEvent) => {
      if (event.type === "text") {
        streamingReply.update(event.text);
      } else if (event.type === "status") {
        streamingReply.status(event.message);
        // Extract tool name from "[Using tool: X]" for reaction emoji
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
        if (!streamingReply.failed()) {
          // Finalize the streamed message with complete text
          await streamingReply.finalize(response);
        } else {
          // Streaming failed — fall back to fresh sendText
          await sendText(bot, chatId, response);
        }
      }
    } catch (err) {
      typing.onCleanup?.();
      await reactionController.setError();
      throw err;
    }
  }
```

Update all call sites of `withTypingAndReactions` to pass `onEvent` through:

Line 165-168 (message:text handler):
```typescript
    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
```

Line 200-203 (message:photo handler):
```typescript
    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
```

Line 236-239 (message:document handler):
```typescript
    withTypingAndReactions(
      String(ctx.chat.id),
      ctx.message.message_id,
      (onEvent) => onMessage(message, onEvent),
    ).catch((err) => {
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels/telegram/bot.ts src/channels/telegram/bot-streaming.test.ts
git commit -m "feat(telegram): wire streaming reply for edit-in-place responses"
```

---

### Task 3: Wire `onEvent` through the Telegram channel creation in lifecycle

**Files:**
- Modify: `src/gateway/lifecycle.ts` (line 265 — Telegram channel creation)

**Step 1: Verify the existing wiring**

The Telegram channel is created at `lifecycle.ts:265`:
```typescript
const telegram = createTelegramChannel(config.channels.telegram, router);
```

`router` is already typed as `(msg: InboundMessage, onEvent?: OnStreamEvent) => Promise<string>` (from `router.ts:158`). The `MessageHandler` type change in Task 1 makes this compatible. The Telegram bot's `onMessage` callback is `router`, and in Task 2 we changed it to `(onEvent) => onMessage(message, onEvent)`.

**This task may already work after Tasks 1-2.** Verify by tracing the call chain:

1. `bot.ts:168`: `(onEvent) => onMessage(message, onEvent)` — `onMessage` is `router`
2. `router.ts:158`: `async (message, onProgress?) => ...` — receives `onEvent` as `onProgress`
3. `router.ts:332`: `pool.submit({...}, onProgress)` — forwards to pool
4. `pool.ts:79`: `submit(task, onEvent?)` — forwards to `spawnClaude`
5. `spawn.ts:19`: `spawnClaude(task, onEvent?)` — fires events on stdout data

**Step 2: Run integration test to verify end-to-end**

Run: `pnpm vitest run src/integration/`
Expected: PASS

**Step 3: Commit** (only if lifecycle.ts needed changes)

If no changes were needed, skip this commit.

---

### Task 4: Wire streaming for Slack inline handler

**Files:**
- Modify: `src/gateway/lifecycle.ts` (lines 275-288 — Slack handler)

**Step 1: Modify Slack handler to use streaming**

The Slack handler is inline in `lifecycle.ts:275-288`. Currently:

```typescript
const slack = createSlackChannel(config.channels.slack, async (msg) => {
  const response = await router({...});
  if (response && msg.chatId) {
    await slack.sendText(msg.chatId, response);
  }
  return response;
});
```

Change to pass `onEvent` and use streaming:

```typescript
const slack = createSlackChannel(config.channels.slack, async (msg, onEvent) => {
  // Create streaming reply if adapter supports editMessage
  let streamingReply: StreamingReply | undefined;
  if (slack.editMessage) {
    const { createStreamingReply } = await import("../channels/streaming.js");
    streamingReply = createStreamingReply({
      sendText: async (text) => {
        const result = await slack.sendText(msg.chatId, text);
        return { messageId: result.messageId };
      },
      editMessage: (msgId, text) => slack.editMessage!(msg.chatId, msgId, text),
    });
  }

  // Forward stream events to streaming reply
  const wrappedOnEvent: OnStreamEvent | undefined = streamingReply
    ? (event) => {
        if (event.type === "text") streamingReply!.update(event.text);
        else if (event.type === "status") streamingReply!.status(event.message);
        onEvent?.(event);
      }
    : onEvent;

  const response = await router({
    channel: msg.channel,
    chatId: msg.chatId,
    userId: msg.userId,
    username: msg.username,
    text: msg.text,
    source: msg.source as "user" | "cron" | "system",
  }, wrappedOnEvent);

  if (response && msg.chatId) {
    if (streamingReply && !streamingReply.failed()) {
      await streamingReply.finalize(response);
    } else {
      await slack.sendText(msg.chatId, response);
    }
  }
  return response;
});
```

Add imports at top of `lifecycle.ts`:

```typescript
import type { OnStreamEvent } from "../engine/types.js";
import type { StreamingReply } from "../channels/streaming.js";
```

**Step 2: Check if Slack adapter has editMessage**

The Slack adapter needs an `editMessage` method. Check if `createSlackChannel` returns one. If not, this is a prerequisite — but Slack's `chat.update` API supports it. For now, if `editMessage` is undefined on the adapter, streaming is skipped and the old behavior applies (graceful degradation).

**Step 3: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 4: Commit**

```bash
git add src/gateway/lifecycle.ts
git commit -m "feat(slack): wire streaming reply for edit-in-place responses"
```

---

### Task 5: Handle edge case — gateway commands and short responses

**Files:**
- Modify: `src/channels/telegram/bot.ts` (streaming reply for gateway commands)

**Step 1: Verify gateway commands don't trigger streaming**

Gateway commands (`/status`, `/help`, etc.) return immediately from the router without spawning Claude. They never fire `onEvent`. In this case:
- `streamingReply` never receives `update()` calls
- `streamingReply.finalize(response)` is called with the command output
- Since no initial message was sent (no `update()` call), `finalize()` needs to handle this

**Step 2: Check streaming.ts finalize behavior when no update() was called**

Read `streaming.ts:139-170`: `finalize()` calls `doEdit()`, which checks `messageId === null` and returns early. So finalize does nothing if no message was ever sent.

This means gateway command responses would be silently dropped. Fix: check if streaming reply was ever used before calling finalize.

**Step 3: Add a `hasStarted()` method to StreamingReply**

In `src/channels/streaming.ts`, add to the interface:

```typescript
export interface StreamingReply {
  update(text: string): void;
  status(message: string): void;
  finalize(finalText: string): Promise<void>;
  failed(): boolean;
  /** Whether any update() or status() call has been made */
  started(): boolean;
}
```

Add to the implementation (after `let hasFailed = false;`):

```typescript
let hasStartedStreaming = false;
```

In `update()` and `sendFirst()`, set `hasStartedStreaming = true;`.

Add to the return object:

```typescript
started: () => hasStartedStreaming,
```

**Step 4: Update bot.ts to check `started()` before finalize**

In the `withTypingAndReactions` try block, replace the response handling:

```typescript
      if (response) {
        if (streamingReply.started() && !streamingReply.failed()) {
          await streamingReply.finalize(response);
        } else {
          // No streaming happened (gateway command) or streaming failed — fresh send
          await sendText(bot, chatId, response);
        }
      }
```

**Step 5: Write test for this edge case**

Add to `bot-streaming.test.ts`:

```typescript
  it("started() returns false when no update was called", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage });

    expect(reply.started()).toBe(false);
  });

  it("started() returns true after update()", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    reply.update("text");

    expect(reply.started()).toBe(true);
  });
```

**Step 6: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 7: Commit**

```bash
git add src/channels/streaming.ts src/channels/telegram/bot.ts src/channels/telegram/bot-streaming.test.ts
git commit -m "fix(streaming): handle gateway commands that skip streaming"
```

---

### Task 6: Accumulate text across multiple assistant events

**Files:**
- Modify: `src/channels/telegram/bot.ts` (onEvent text accumulation)

**Step 1: Understand the text event pattern**

`spawn.ts` fires `{ type: "text", text: "block content" }` for each `assistant` message's text block. Claude Code may emit multiple assistant events during a single turn (e.g., reasoning → tool use → more reasoning). Each `text` event contains a complete text block, not a delta.

The `streamingReply.update()` expects the **full accumulated text** so far (it replaces the message, not appends). We need to accumulate text blocks across events.

**Step 2: Add accumulator to onEvent callback in bot.ts**

In the `withTypingAndReactions` function, before the `onEvent` definition:

```typescript
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
```

**Step 3: Write test**

Add to `bot-streaming.test.ts`:

```typescript
  it("accumulates multiple text events into single message", () => {
    const sendText = vi.fn().mockResolvedValue({ messageId: 42 });
    const editMessage = vi.fn().mockResolvedValue(undefined);
    const reply = createStreamingReply({ sendText, editMessage, throttleMs: 0 });

    // Simulate two text blocks
    reply.update("First paragraph");
    reply.update("First paragraph\n\nSecond paragraph");

    // First call sends, second should schedule an edit
    expect(sendText).toHaveBeenCalledWith("First paragraph");
  });
```

**Step 4: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 5: Commit**

```bash
git add src/channels/telegram/bot.ts src/channels/telegram/bot-streaming.test.ts
git commit -m "feat(telegram): accumulate text blocks across assistant events"
```

---

## Summary

| Task | What | Files | Effort |
|------|------|-------|--------|
| 1 | Extend `MessageHandler` type | types.ts | ~2 min |
| 2 | Wire streaming into Telegram handler | bot.ts + test | ~15 min |
| 3 | Verify lifecycle wiring (may be no-op) | lifecycle.ts | ~5 min |
| 4 | Wire streaming for Slack | lifecycle.ts | ~10 min |
| 5 | Handle gateway commands edge case | streaming.ts + bot.ts + test | ~10 min |
| 6 | Accumulate text across events | bot.ts + test | ~5 min |

**Total: ~45 minutes**

After this, users will see their agent's response building up in real-time in Telegram (and Slack if `editMessage` is available on the adapter). Gateway commands (`/status`, `/help`) continue to send a single message as before. If any streaming edit fails, the system falls back silently to the current behavior (single message at end).
