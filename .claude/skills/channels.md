---
name: channels
description: Channel abstraction layer with Telegram (grammY) and Slack (Bolt) adapters
---

# Channels - Messaging Adapters

Abstraction layer for messaging platforms. Currently supports Telegram (grammY) and Slack (Bolt).

## When to Use This Skill

- Adding a new messaging channel
- Modifying Telegram or Slack integration
- Working with message handling, chunking, or access control
- Debugging channel connectivity issues

## Key Files

### Shared
- `src/channels/types.ts` - ChannelAdapter, InboundMessage, MessageHandler interfaces

### Telegram
- `src/channels/telegram/bot.ts` - grammY bot, long-polling, message handling
- `src/channels/telegram/send.ts` - Send text/media with chunking
- `src/channels/telegram/index.ts` - createTelegramChannel export

### Slack
- `src/channels/slack/bot.ts` - Bolt bot, socket mode
- `src/channels/slack/send.ts` - Send text/media with chunking
- `src/channels/slack/index.ts` - createSlackChannel export

## Architecture

### Channel Interface

```typescript
interface ChannelAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId, text): Promise<SendResult>;
  sendMedia?(chatId, media, caption?): Promise<SendResult>;
}

interface InboundMessage {
  channel: string;       // "telegram" | "slack"
  chatId: string;
  userId: string;
  username?: string;
  text: string;
  source: "user" | "cron" | "system";
  media?: MediaAttachment[];
  threadId?: string;
}

type MessageHandler = (message: InboundMessage) => Promise<string>;
```

### Message Flow

```
Channel receives message → allow-list check → MessageHandler(inbound) → router → engine → response → sendText()
```

### Telegram Specifics

- grammY v1.41 with transformer-throttler for rate limiting
- Long-polling with exponential backoff (2s→30s, factor 1.8, jitter 0.25)
- Auto-restart on polling failure
- **409 Conflict**: Only one process can poll a bot token

### Slack Specifics

- @slack/bolt v4.6 with Socket Mode
- Listens to message events, auto-threads replies
- Requires both `botToken` and `appToken`

### Access Control

Both channels support `allowFrom` — array of user IDs. **Omit entirely to allow all users.** An empty array `[]` blocks everyone.

## OpenClaw Reference

**Channels were extracted from OpenClaw.** When adding features or fixing bugs, check the upstream first.

### Telegram
**Source:** `openclaw-source/src/telegram/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `bot.ts` | `src/channels/telegram/bot.ts` | Simplified — removed forum topics, approval buttons, multi-bot |
| `send.ts` | `src/channels/telegram/send.ts` | Simplified — removed draft streaming, lane delivery |
| `bot-access.ts` | — | Complex group/DM access policies |
| `format.ts` | — | Markdown formatting helpers |
| `draft-stream.ts` | — | Real-time message streaming |
| `bot-message-context.ts` | — | Rich context extraction |

### Slack
**Source:** `openclaw-source/src/slack/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `client.ts` | `src/channels/slack/bot.ts` | Simplified — removed actions, modals, blocks |
| `send.ts` | `src/channels/slack/send.ts` | Simplified — removed blocks, uploads, streaming |
| `threading.ts` | — | Complex thread management |
| `stream-mode.ts` | — | Real-time streaming |

### Channel Abstraction
**Source:** `openclaw-source/src/channels/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `allow-from.ts` | (inline) | Allow-list logic |
| `session.ts` | — | Channel session management |
| `dock.ts` | — | Multi-channel registry |
| `run-state-machine.ts` | — | Message processing state machine |

**Copy-first workflow:**
1. Find the feature in `openclaw-source/src/telegram/`, `src/slack/`, or `src/channels/`
2. Copy the implementation
3. Strip OpenClaw-specific deps (Pi runtime, multi-agent, plugins, draft streaming, approval system)
4. Adapt to the simpler `ChannelAdapter` interface
5. Rename any "openclaw" references to "openclaude"
