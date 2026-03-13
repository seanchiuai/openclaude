/**
 * Telegram typing indicator with keepalive.
 * Simplified from OpenClaw's channels/typing.ts.
 *
 * Sends "typing" chat action immediately and repeats every 4s
 * (Telegram's typing indicator expires after ~5s).
 * Auto-stops after 5 minutes as a safety net.
 */
import type { Bot } from "grammy";

const KEEPALIVE_MS = 4_000;
const MAX_DURATION_MS = 5 * 60 * 1000;

export interface TypingHandle {
  stop(): void;
}

export function startTyping(bot: Bot, chatId: string): TypingHandle {
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let safetyTimer: ReturnType<typeof setTimeout> | undefined;

  const sendAction = () => {
    if (stopped) return;
    bot.api.sendChatAction(chatId, "typing").catch(() => {
      // Silently ignore errors (chat deleted, bot kicked, etc.)
    });
  };

  // Fire immediately
  sendAction();

  // Keepalive every 4s
  timer = setInterval(sendAction, KEEPALIVE_MS);

  // Safety TTL
  safetyTimer = setTimeout(() => {
    stop();
  }, MAX_DURATION_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
    if (safetyTimer) {
      clearTimeout(safetyTimer);
      safetyTimer = undefined;
    }
  }

  return { stop };
}
