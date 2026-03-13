export const SLACK_MESSAGE_LIMIT = 4000;

export interface SendResult {
  messageId: string;
  success: boolean;
}

export interface MediaAttachment {
  type: string;
  url?: string;
  buffer?: Buffer;
  filename?: string;
}

export function splitSlackTextChunks(text: string, limit = SLACK_MESSAGE_LIMIT): string[] {
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

export async function sendSlackText(
  client: { chat: { postMessage: (params: Record<string, unknown>) => Promise<{ ts: string }> } },
  channel: string,
  text: string,
  threadTs?: string,
): Promise<SendResult> {
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

export async function sendSlackMedia(
  client: { files: { uploadV2: (params: Record<string, unknown>) => Promise<{ file?: { id?: string } }> } },
  channel: string,
  media: MediaAttachment,
  caption?: string,
): Promise<SendResult> {
  const result = await client.files.uploadV2({
    channel_id: channel,
    file: media.buffer ?? media.url,
    filename: media.filename ?? "file",
    initial_comment: caption,
  });
  return { messageId: result.file?.id ?? "file-uploaded", success: true };
}
