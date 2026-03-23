# Typing Indicators & Status Reactions — Port from OpenClaw

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Port OpenClaw's typing indicator and status reaction system so users see immediate feedback (typing bubble + emoji reactions) when OpenClaude processes their messages.

**Architecture:** Copy OpenClaw's channel-agnostic typing/reaction abstractions, then wire Telegram-specific adapters. The core modules (typing callbacks, keepalive loop, start guard, status reactions) are direct copies. The 401 backoff handler and reaction variant resolver are Telegram-specific. Integration happens in `bot.ts` where we replace our current naive `startTyping()` with the full lifecycle. A small backoff utility is inlined since we don't have OpenClaw's `infra/` module.

**Tech Stack:** TypeScript (ESM), grammY (Telegram Bot API), vitest

---

### Task 1: Port backoff utility

The 401 backoff handler depends on `infra/backoff.ts`. We don't have an `infra/` module — inline the two functions into a new file.

**Files:**
- Create: `src/channels/backoff.ts`
- Test: `src/channels/backoff.test.ts`

**Step 1: Write the test**

```typescript
// src/channels/backoff.test.ts
import { describe, it, expect } from "vitest";
import { computeBackoff } from "./backoff.js";

describe("computeBackoff", () => {
  it("returns initialMs for attempt 1", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0 },
      1,
    );
    expect(result).toBe(1000);
  });

  it("doubles for attempt 2 with factor 2", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0 },
      2,
    );
    expect(result).toBe(2000);
  });

  it("caps at maxMs", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 5000, factor: 2, jitter: 0 },
      20,
    );
    expect(result).toBe(5000);
  });

  it("adds jitter", () => {
    const result = computeBackoff(
      { initialMs: 1000, maxMs: 30_000, factor: 2, jitter: 0.5 },
      1,
    );
    expect(result).toBeGreaterThanOrEqual(1000);
    expect(result).toBeLessThanOrEqual(1500);
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/backoff.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

```typescript
// src/channels/backoff.ts
// Extracted from OpenClaw's infra/backoff.ts
import { setTimeout as delay } from "node:timers/promises";

export type BackoffPolicy = {
  initialMs: number;
  maxMs: number;
  factor: number;
  jitter: number;
};

export function computeBackoff(policy: BackoffPolicy, attempt: number): number {
  const base = policy.initialMs * policy.factor ** Math.max(attempt - 1, 0);
  const jitter = base * policy.jitter * Math.random();
  return Math.min(policy.maxMs, Math.round(base + jitter));
}

export async function sleepWithAbort(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  try {
    await delay(ms, undefined, { signal: abortSignal });
  } catch (err) {
    if (abortSignal?.aborted) {
      throw new Error("aborted", { cause: err });
    }
    throw err;
  }
}
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/backoff.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add backoff utility (ported from OpenClaw infra/backoff)
```

---

### Task 2: Port typing-start-guard

Direct copy from OpenClaw. No dependencies on other new files.

**Files:**
- Create: `src/channels/typing-start-guard.ts`
- Create: `src/channels/typing-start-guard.test.ts`

**Step 1: Write the test**

Copy verbatim from `openclaw-source/src/channels/typing-start-guard.test.ts`. Only change: import path points to `./typing-start-guard.js`.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/typing-start-guard.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Copy verbatim from `openclaw-source/src/channels/typing-start-guard.ts`. No import changes needed (no external deps).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/typing-start-guard.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add typing start guard (ported from OpenClaw)
```

---

### Task 3: Port typing-lifecycle (keepalive loop)

Direct copy from OpenClaw. No dependencies.

**Files:**
- Create: `src/channels/typing-lifecycle.ts`

**Step 1: Write implementation**

Copy verbatim from `openclaw-source/src/channels/typing-lifecycle.ts`. No import changes needed.

No separate test file in OpenClaw — tested via typing.test.ts (Task 4).

**Step 2: Commit**

```
feat: add typing keepalive loop (ported from OpenClaw)
```

---

### Task 4: Port typing callbacks

Depends on Task 2 (typing-start-guard) and Task 3 (typing-lifecycle).

**Files:**
- Create: `src/channels/typing.ts`
- Create: `src/channels/typing.test.ts`

**Step 1: Write the test**

Copy verbatim from `openclaw-source/src/channels/typing.test.ts`. Only change: import path points to `./typing.js`.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/typing.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Copy verbatim from `openclaw-source/src/channels/typing.ts`. Import paths stay the same (`./typing-lifecycle.js`, `./typing-start-guard.js`).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/typing.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add typing callbacks with circuit breaker and TTL (ported from OpenClaw)
```

---

### Task 5: Port status-reactions

Direct copy from OpenClaw. No external dependencies.

**Files:**
- Create: `src/channels/status-reactions.ts`
- Create: `src/channels/status-reactions.test.ts`

**Step 1: Write the test**

Copy verbatim from `openclaw-source/src/channels/status-reactions.test.ts`. Only change: import path points to `./status-reactions.js`.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/status-reactions.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Copy verbatim from `openclaw-source/src/channels/status-reactions.ts`. No import changes needed (no external deps).

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/status-reactions.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add status reaction controller with debounce and stall detection (ported from OpenClaw)
```

---

### Task 6: Port Telegram 401 backoff handler

Depends on Task 1 (backoff utility).

**Files:**
- Create: `src/channels/telegram/sendchataction-401-backoff.ts`
- Create: `src/channels/telegram/sendchataction-401-backoff.test.ts`

**Step 1: Write the test**

Copy from `openclaw-source/src/telegram/sendchataction-401-backoff.test.ts`. Change the mock import path from `../infra/backoff.js` to `../backoff.js`.

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/telegram/sendchataction-401-backoff.test.ts`
Expected: FAIL — module not found

**Step 3: Write implementation**

Copy from `openclaw-source/src/telegram/sendchataction-401-backoff.ts`. Change import from `../infra/backoff.js` to `../backoff.js`.

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/telegram/sendchataction-401-backoff.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add Telegram sendChatAction 401 backoff handler (ported from OpenClaw)
```

---

### Task 7: Port Telegram status reaction variants

Depends on Task 5 (status-reactions).

**Files:**
- Create: `src/channels/telegram/status-reaction-variants.ts`

**Step 1: Write implementation**

Copy from `openclaw-source/src/telegram/status-reaction-variants.ts`. Change import from `../channels/status-reactions.js` to `../status-reactions.js`.

No test — tested transitively; the variant resolver is pure logic with fallback chains.

**Step 2: Commit**

```
feat: add Telegram reaction emoji variants and fallbacks (ported from OpenClaw)
```

---

### Task 8: Add `reactMessage` to Telegram send module

We need a function to set emoji reactions on messages via the Telegram Bot API.

**Files:**
- Modify: `src/channels/telegram/send.ts`
- Modify: `src/channels/telegram/send.test.ts`

**Step 1: Write the failing test**

Add to `src/channels/telegram/send.test.ts`:

```typescript
describe("reactMessage", () => {
  it("calls setMessageReaction with emoji", async () => {
    const bot = {
      api: {
        setMessageReaction: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Bot;

    const result = await reactMessage(bot, "123", 42, "👀");
    expect(result).toEqual({ ok: true });
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith(
      "123",
      42,
      [{ type: "emoji", emoji: "👀" }],
    );
  });

  it("removes reaction when remove=true", async () => {
    const bot = {
      api: {
        setMessageReaction: vi.fn().mockResolvedValue(true),
      },
    } as unknown as Bot;

    const result = await reactMessage(bot, "123", 42, "👀", { remove: true });
    expect(result).toEqual({ ok: true });
    expect(bot.api.setMessageReaction).toHaveBeenCalledWith("123", 42, []);
  });

  it("returns warning on REACTION_INVALID error", async () => {
    const bot = {
      api: {
        setMessageReaction: vi.fn().mockRejectedValue(new Error("REACTION_INVALID")),
      },
    } as unknown as Bot;

    const result = await reactMessage(bot, "123", 42, "🦄");
    expect(result).toEqual({ ok: false, warning: expect.stringContaining("REACTION_INVALID") });
  });
});
```

**Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/channels/telegram/send.test.ts`
Expected: FAIL — reactMessage not exported

**Step 3: Write implementation**

Add to `src/channels/telegram/send.ts`:

```typescript
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
```

**Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/channels/telegram/send.test.ts`
Expected: PASS

**Step 5: Commit**

```
feat: add reactMessage to Telegram send module
```

---

### Task 9: Wire typing + reactions into Telegram bot

Replace our naive `startTyping()` with the full OpenClaw lifecycle. This is the integration task.

**Files:**
- Modify: `src/channels/telegram/bot.ts` — replace typing import and handler logic
- Delete: `src/channels/telegram/typing.ts` — our naive implementation, replaced by channel-agnostic core
- Modify: `src/channels/telegram/bot.test.ts` — update mock to cover `sendChatAction` + `setMessageReaction`

**Step 1: Update bot.ts**

Replace the import and handler logic. The new flow per message handler:

```typescript
import { createTypingCallbacks } from "../typing.js";
import { createTelegramSendChatActionHandler } from "./sendchataction-401-backoff.js";
import { createStatusReactionController } from "../status-reactions.js";
import {
  resolveTelegramStatusReactionEmojis,
  buildTelegramStatusReactionVariants,
  resolveTelegramReactionVariant,
} from "./status-reaction-variants.js";
import { reactMessage } from "./send.js";
```

In `createTelegramChannel`:

```typescript
// Create a GLOBAL 401 backoff handler (shared across all chats)
const chatActionHandler = createTelegramSendChatActionHandler({
  sendChatActionFn: (chatId, action) => bot.api.sendChatAction(String(chatId), action),
  logger: (msg) => console.warn(`[telegram] ${msg}`),
});

// Resolve emoji variants once at startup
const emojis = resolveTelegramStatusReactionEmojis({ initialEmoji: "👀" });
const variantsByEmoji = buildTelegramStatusReactionVariants(emojis);
```

Each message handler becomes:

```typescript
bot.on("message:text", async (ctx) => {
  // ... allow-list check, build InboundMessage ...

  const chatId = String(ctx.chat.id);
  const messageId = ctx.message.message_id;

  // Status reaction: 👀 immediately
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

  // Typing indicator
  const typing = createTypingCallbacks({
    start: () => chatActionHandler.sendChatAction(chatId, "typing"),
    onStartError: (err) => console.warn("[telegram] typing error:", err),
    maxDurationMs: 300_000, // 5 min (Claude can be slow)
  });
  await typing.onReplyStart();

  try {
    const response = await onMessage(message);
    typing.onIdle?.();
    await reactionController.setDone();
    if (response) {
      await sendText(bot, chatId, response);
    }
  } catch (err) {
    typing.onCleanup?.();
    await reactionController.setError();
    throw err;
  }
});
```

**Step 2: Delete `src/channels/telegram/typing.ts`**

Our naive implementation is no longer needed.

**Step 3: Update `bot.test.ts`**

Add `setMessageReaction: vi.fn().mockResolvedValue(true)` to the mock bot API alongside the existing `sendChatAction` mock.

Update tests to verify:
- `sendChatAction` is called with "typing" during message processing
- `setMessageReaction` is called with queued emoji on message arrival
- Both are stopped/updated after response

**Step 4: Run all tests**

Run: `pnpm vitest run src/channels/telegram/`
Expected: PASS

**Step 5: Run full test suite**

Run: `pnpm test`
Expected: all pass (except pre-existing spawn-edge-cases failure)

**Step 6: Commit**

```
feat: wire OpenClaw typing + status reactions into Telegram bot

Replace naive typing.ts with channel-agnostic typing callbacks,
401 backoff handler, and status reaction controller. Users now see:
- 👀 reaction immediately on message receipt
- "typing..." indicator while Claude processes
- 👍 reaction on success, 😱 on error
- Stall detection (🥱 after 10s, 😨 after 30s of no state change)
```

---

### Task 10: Extract shared handler helper to reduce duplication

The three message handlers (text, photo, document) now have identical typing/reaction logic. Extract a `withTypingAndReactions` wrapper.

**Files:**
- Modify: `src/channels/telegram/bot.ts`

**Step 1: Extract helper**

```typescript
async function withTypingAndReactions(
  chatId: string,
  messageId: number,
  handler: () => Promise<string>,
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
    onStartError: (err) => console.warn("[telegram] typing error:", err),
    maxDurationMs: 300_000,
  });
  await typing.onReplyStart();

  try {
    const response = await handler();
    typing.onIdle?.();
    await reactionController.setDone();
    if (response) {
      await sendText(bot, chatId, response);
    }
  } catch (err) {
    typing.onCleanup?.();
    await reactionController.setError();
    throw err;
  }
}
```

Each handler becomes:

```typescript
bot.on("message:text", async (ctx) => {
  // ... allow-list, build message ...
  await withTypingAndReactions(
    String(ctx.chat.id),
    ctx.message.message_id,
    () => onMessage(message),
  );
});
```

**Step 2: Run tests**

Run: `pnpm test`
Expected: PASS

**Step 3: Commit**

```
refactor: extract withTypingAndReactions helper to reduce duplication
```
