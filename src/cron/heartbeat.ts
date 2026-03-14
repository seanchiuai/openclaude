/**
 * Heartbeat runner — periodic health-check system.
 * Adapted from openclaw-source/src/infra/heartbeat-runner.ts.
 *
 * Key behaviors ported from OpenClaw:
 * - HEARTBEAT_OK token detection with markup stripping
 * - isHeartbeatContentEffectivelyEmpty — skip comment-only checklists
 * - Configurable prompt (from config, not hardcoded)
 * - Active hours / quiet hours support
 * - Duplicate suppression (same message within 24h)
 * - ackMaxChars threshold for short ok-adjacent responses
 *
 * Divergence from OpenClaw: execution delegates to Claude Code CLI via
 * deps.runIsolated() rather than OpenClaw's internal agent system.
 */

import { readFileSync, existsSync } from "node:fs";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";

// ── Token & prompt constants (from openclaw-source/src/auto-reply/tokens.ts + heartbeat.ts) ──

export const HEARTBEAT_TOKEN = "HEARTBEAT_OK";

export const HEARTBEAT_PROMPT =
  "Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.";

export const DEFAULT_HEARTBEAT_ACK_MAX_CHARS = 300;

// ── Active hours (from openclaw-source/src/infra/heartbeat-active-hours.ts) ──

export interface ActiveHours {
  start: string; // "HH:MM" (24h format)
  end: string;   // "HH:MM" or "24:00"
  timezone?: string;
}

const ACTIVE_HOURS_TIME_PATTERN = /^(?:([01]\d|2[0-3]):([0-5]\d)|24:00)$/;

function parseActiveHoursTime(opts: { allow24: boolean }, raw?: string): number | null {
  if (!raw || !ACTIVE_HOURS_TIME_PATTERN.test(raw)) {
    return null;
  }
  const [hourStr, minuteStr] = raw.split(":");
  const hour = Number(hourStr);
  const minute = Number(minuteStr);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
    return null;
  }
  if (hour === 24) {
    if (!opts.allow24 || minute !== 0) {
      return null;
    }
    return 24 * 60;
  }
  return hour * 60 + minute;
}

function resolveMinutesInTimeZone(nowMs: number, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(nowMs));
    const map: Record<string, string> = {};
    for (const part of parts) {
      if (part.type !== "literal") {
        map[part.type] = part.value;
      }
    }
    const hour = Number(map.hour);
    const minute = Number(map.minute);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return hour * 60 + minute;
  } catch {
    return null;
  }
}

export function isWithinActiveHours(
  activeHours?: ActiveHours,
  nowMs?: number,
): boolean {
  if (!activeHours) {
    return true;
  }

  const startMin = parseActiveHoursTime({ allow24: false }, activeHours.start);
  const endMin = parseActiveHoursTime({ allow24: true }, activeHours.end);
  if (startMin === null || endMin === null) {
    return true;
  }
  if (startMin === endMin) {
    return false;
  }

  const timeZone = activeHours.timezone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const currentMin = resolveMinutesInTimeZone(nowMs ?? Date.now(), timeZone);
  if (currentMin === null) {
    return true;
  }

  if (endMin > startMin) {
    return currentMin >= startMin && currentMin < endMin;
  }
  // Wraps midnight (e.g. 22:00 → 06:00)
  return currentMin >= startMin || currentMin < endMin;
}

// ── Heartbeat content detection (from openclaw-source/src/auto-reply/heartbeat.ts) ──

/**
 * Check if HEARTBEAT.md content is "effectively empty" — no actionable tasks.
 * A file with only whitespace, markdown headers, and empty list items is empty.
 */
export function isHeartbeatContentEffectivelyEmpty(content: string | undefined | null): boolean {
  if (content === undefined || content === null) {
    return false;
  }
  if (typeof content !== "string") {
    return false;
  }

  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    // Skip markdown header lines (# followed by space or EOL)
    if (/^#+(\s|$)/.test(trimmed)) {
      continue;
    }
    // Skip empty markdown list items like "- [ ]" or "* [ ]" or just "- "
    if (/^[-*+]\s*(\[[\sXx]?\]\s*)?$/.test(trimmed)) {
      continue;
    }
    return false;
  }
  return true;
}

// ── Token stripping (from openclaw-source/src/auto-reply/heartbeat.ts) ──

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripTokenAtEdges(raw: string): { text: string; didStrip: boolean } {
  let text = raw.trim();
  if (!text) {
    return { text: "", didStrip: false };
  }

  const token = HEARTBEAT_TOKEN;
  const tokenAtEndWithOptionalTrailingPunctuation = new RegExp(
    `${escapeRegExp(token)}[^\\w]{0,4}$`,
  );
  if (!text.includes(token)) {
    return { text, didStrip: false };
  }

  let didStrip = false;
  let changed = true;
  while (changed) {
    changed = false;
    const next = text.trim();
    if (next.startsWith(token)) {
      const after = next.slice(token.length).trimStart();
      text = after;
      didStrip = true;
      changed = true;
      continue;
    }
    if (tokenAtEndWithOptionalTrailingPunctuation.test(next)) {
      const idx = next.lastIndexOf(token);
      const before = next.slice(0, idx).trimEnd();
      if (!before) {
        text = "";
      } else {
        const after = next.slice(idx + token.length).trimStart();
        text = `${before}${after}`.trimEnd();
      }
      didStrip = true;
      changed = true;
    }
  }

  const collapsed = text.replace(/\s+/g, " ").trim();
  return { text: collapsed, didStrip };
}

/**
 * Strip lightweight markup (HTML tags, markdown bold/italic) so
 * HEARTBEAT_OK wrapped in formatting still matches.
 */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/^[*`~_]+/, "")
    .replace(/[*`~_]+$/, "");
}

export function stripHeartbeatToken(
  raw?: string,
  opts: { maxAckChars?: number } = {},
): { shouldSkip: boolean; text: string; didStrip: boolean } {
  if (!raw) {
    return { shouldSkip: true, text: "", didStrip: false };
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return { shouldSkip: true, text: "", didStrip: false };
  }

  const maxAckChars = Math.max(
    0,
    typeof opts.maxAckChars === "number" && Number.isFinite(opts.maxAckChars)
      ? opts.maxAckChars
      : DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
  );

  const trimmedNormalized = stripMarkup(trimmed);
  const hasToken = trimmed.includes(HEARTBEAT_TOKEN) || trimmedNormalized.includes(HEARTBEAT_TOKEN);
  if (!hasToken) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  const strippedOriginal = stripTokenAtEdges(trimmed);
  const strippedNormalized = stripTokenAtEdges(trimmedNormalized);
  const picked =
    strippedOriginal.didStrip && strippedOriginal.text ? strippedOriginal : strippedNormalized;
  if (!picked.didStrip) {
    return { shouldSkip: false, text: trimmed, didStrip: false };
  }

  if (!picked.text) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  const rest = picked.text.trim();
  if (rest.length <= maxAckChars) {
    return { shouldSkip: true, text: "", didStrip: true };
  }

  return { shouldSkip: false, text: rest, didStrip: true };
}

// ── Legacy compat: keep isHeartbeatOk as a thin wrapper ──

export function isHeartbeatOk(text: string): boolean {
  const result = stripHeartbeatToken(text, { maxAckChars: DEFAULT_HEARTBEAT_ACK_MAX_CHARS });
  return result.shouldSkip;
}

// ── Heartbeat prompt resolution (from openclaw-source/src/auto-reply/heartbeat.ts) ──

export function resolveHeartbeatPrompt(raw?: string): string {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || HEARTBEAT_PROMPT;
}

// ── Heartbeat runner ──

export interface HeartbeatConfig {
  enabled: boolean;
  every: number;
  checklistPath: string;
  prompt?: string;
  ackMaxChars?: number;
  target?: CronDeliveryTarget;
  activeHours?: ActiveHours;
}

export interface HeartbeatDeps {
  runIsolated: (prompt: string) => Promise<CronRunOutcome>;
  deliver?: (target: CronDeliveryTarget, text: string) => Promise<void>;
  nowMs?: () => number;
}

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
  runOnce(): Promise<CronRunOutcome>;
  isRunning(): boolean;
}

/** Duplicate suppression window — same as OpenClaw (24 hours). */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

export function createHeartbeatRunner(
  config: HeartbeatConfig,
  deps: HeartbeatDeps,
): HeartbeatRunner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let executing = false;

  // Duplicate suppression state
  let lastDeliveredText: string | undefined;
  let lastDeliveredAtMs: number | undefined;

  async function runOnce(): Promise<CronRunOutcome> {
    if (executing) {
      return { status: "skipped", error: "Already executing" };
    }

    executing = true;
    try {
      const nowMs = (deps.nowMs ?? Date.now)();

      // Active hours gate
      if (!isWithinActiveHours(config.activeHours, nowMs)) {
        return { status: "skipped", error: "Outside active hours" };
      }

      if (!existsSync(config.checklistPath)) {
        // Missing file is not an error — the prompt already says "if it exists".
        // Still run the heartbeat so the model can check other things.
      }

      let content: string | undefined;
      if (existsSync(config.checklistPath)) {
        content = readFileSync(config.checklistPath, "utf-8");
      }

      // Skip if checklist exists but is effectively empty (only headers/empty items)
      if (content !== undefined && isHeartbeatContentEffectivelyEmpty(content)) {
        return { status: "skipped", error: "Checklist is empty" };
      }

      const basePrompt = resolveHeartbeatPrompt(config.prompt);
      const prompt = content?.trim()
        ? `${basePrompt}\n\n${content.trim()}`
        : basePrompt;

      const outcome = await deps.runIsolated(prompt);

      if (outcome.status !== "ok" || !outcome.summary) {
        return outcome;
      }

      // Strip HEARTBEAT_OK token — matches OpenClaw's behavior
      const stripped = stripHeartbeatToken(outcome.summary, {
        maxAckChars: config.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS,
      });

      // If response is just the ok token (or short ack), nothing to deliver
      if (stripped.shouldSkip) {
        return outcome;
      }

      // Deliver non-trivial result
      if (config.target && deps.deliver) {
        const deliveryText = stripped.didStrip ? stripped.text : outcome.summary;

        // Duplicate suppression: don't nag with same message within 24h
        const isDuplicate =
          lastDeliveredText !== undefined &&
          lastDeliveredAtMs !== undefined &&
          deliveryText.trim() === lastDeliveredText.trim() &&
          nowMs - lastDeliveredAtMs < DEDUPE_WINDOW_MS;

        if (!isDuplicate) {
          await deps.deliver(config.target, deliveryText);
          lastDeliveredText = deliveryText;
          lastDeliveredAtMs = nowMs;
        }
      }

      return outcome;
    } finally {
      executing = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      timer = setInterval(() => {
        void runOnce();
      }, config.every);
    },

    stop() {
      running = false;
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
    },

    runOnce,

    isRunning() {
      return running;
    },
  };
}
