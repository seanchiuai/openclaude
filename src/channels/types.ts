/**
 * Channel abstraction types.
 * Simplified from OpenClaw's channels/plugins/types.plugin.ts.
 */

export interface InboundMessage {
  /** Channel the message came from */
  channel: string;
  /** Chat/conversation ID */
  chatId: string;
  /** User ID who sent the message */
  userId: string;
  /** Username (display name) */
  username?: string;
  /** Message text content */
  text: string;
  /** Source of the message */
  source: "user" | "cron" | "system";
  /** Optional media attachments */
  media?: MediaAttachment[];
  /** Raw platform-specific data */
  raw?: unknown;
  /** Thread ID (platform-specific) */
  threadId?: string;
}

export interface MediaAttachment {
  type: "photo" | "document" | "audio" | "video";
  url?: string;
  fileId?: string;
  mimeType?: string;
  fileName?: string;
}

export interface OutboundMessage {
  chatId: string;
  text: string;
  parseMode?: "markdown" | "html" | "plain";
  replyToMessageId?: number;
}

export interface SendResult {
  messageId: string | number;
  success: boolean;
}

export interface ChannelAdapter {
  id: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  sendText(chatId: string, text: string): Promise<SendResult>;
  editMessage?(chatId: string, messageId: string | number, text: string): Promise<void>;
  sendMedia?(
    chatId: string,
    media: MediaAttachment,
    caption?: string,
  ): Promise<SendResult>;
}

/** Returns the response text to send back to the user. */
export type MessageHandler = (message: InboundMessage) => Promise<string>;
