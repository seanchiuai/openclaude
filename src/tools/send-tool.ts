/**
 * Send tool — allows the agent to send messages to any registered channel.
 */

import type { ChannelAdapter, SendResult } from "../channels/types.js";

export interface SendParams {
  channel: string;
  chatId: string;
  text: string;
}

export interface SendToolResult extends SendResult {
  error?: string;
}

export interface SendTool {
  execute(params: SendParams): Promise<SendToolResult>;
}

export function createSendTool(
  channels: Map<string, ChannelAdapter>,
): SendTool {
  return {
    async execute(params: SendParams): Promise<SendToolResult> {
      const adapter = channels.get(params.channel);
      if (!adapter) {
        return {
          messageId: "",
          success: false,
          error: `Unknown channel: ${params.channel}`,
        };
      }
      return adapter.sendText(params.chatId, params.text);
    },
  };
}
