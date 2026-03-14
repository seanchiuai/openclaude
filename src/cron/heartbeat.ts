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
 * - Multi-agent scheduling with per-agent intervals
 * - Wake integration for event-driven heartbeats
 *
 * Divergence from OpenClaw: execution delegates to Claude Code CLI via
 * deps.runIsolated() rather than OpenClaw's internal agent system.
 */

import { readFileSync, existsSync } from "node:fs";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";
import type { HeartbeatAgentConfig } from "../config/types.js";
import { setHeartbeatWakeHandler } from "./heartbeat-wake.js";
import { emitHeartbeatEvent } from "./heartbeat-events.js";

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
  agents?: HeartbeatAgentConfig[];
}

export interface HeartbeatDeps {
  runIsolated: (prompt: string) => Promise<CronRunOutcome>;
  deliver?: (target: CronDeliveryTarget, text: string) => Promise<void>;
  nowMs?: () => number;
}

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
  runOnce(agentId?: string): Promise<CronRunOutcome>;
  isRunning(): boolean;
  updateConfig(config: HeartbeatConfig): void;
}

/** Duplicate suppression window — same as OpenClaw (24 hours). */
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Multi-agent state ──

export interface HeartbeatAgentState {
  agentId: string;
  config: HeartbeatAgentConfig;
  intervalMs: number;
  lastRunMs?: number;
  nextDueMs: number;
}

/**
 * Resolve heartbeat agents from config. If `config.agents` is set, merge each
 * agent with top-level defaults. If absent, produce a single "default" agent.
 */
export function resolveHeartbeatAgents(config: HeartbeatConfig): HeartbeatAgentState[] {
  const nowMs = Date.now();
  if (config.agents && config.agents.length > 0) {
    return config.agents.map((agentCfg) => {
      const intervalMs = agentCfg.every ?? config.every;
      return {
        agentId: agentCfg.id,
        config: {
          id: agentCfg.id,
          every: agentCfg.every ?? config.every,
          prompt: agentCfg.prompt ?? config.prompt,
          ackMaxChars: agentCfg.ackMaxChars ?? config.ackMaxChars,
          target: agentCfg.target ?? config.target,
          activeHours: agentCfg.activeHours ?? config.activeHours,
        },
        intervalMs,
        nextDueMs: nowMs + intervalMs,
      };
    });
  }

  return [
    {
      agentId: "default",
      config: {
        id: "default",
        every: config.every,
        prompt: config.prompt,
        ackMaxChars: config.ackMaxChars,
        target: config.target,
        activeHours: config.activeHours,
      },
      intervalMs: config.every,
      nextDueMs: nowMs + config.every,
    },
  ];
}

export function createHeartbeatRunner(
  initialConfig: HeartbeatConfig,
  deps: HeartbeatDeps,
): HeartbeatRunner {
  let config = initialConfig;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let executing = false;
  let wakeDisposer: (() => void) | undefined;
  let agents: HeartbeatAgentState[] = resolveHeartbeatAgents(config);

  const dedupeState = new Map<string, { text: string; atMs: number }>();

  async function runAgentOnce(agent: HeartbeatAgentState): Promise<CronRunOutcome> {
    const nowMs = (deps.nowMs ?? Date.now)();

    if (!isWithinActiveHours(agent.config.activeHours, nowMs)) {
      emitHeartbeatEvent({ status: "skipped", reason: "Outside active hours" });
      return { status: "skipped", error: "Outside active hours" };
    }

    if (!existsSync(config.checklistPath)) {
      // Missing file is not an error — the prompt already says "if it exists".
    }

    let content: string | undefined;
    if (existsSync(config.checklistPath)) {
      content = readFileSync(config.checklistPath, "utf-8");
    }

    // Skip if checklist exists but is effectively empty
    if (content !== undefined && isHeartbeatContentEffectivelyEmpty(content)) {
      emitHeartbeatEvent({ status: "skipped", reason: "Checklist is empty" });
      return { status: "skipped", error: "Checklist is empty" };
    }

    const basePrompt = resolveHeartbeatPrompt(agent.config.prompt);
    const prompt = content?.trim()
      ? `${basePrompt}\n\n${content.trim()}`
      : basePrompt;

    const startMs = Date.now();
    const outcome = await deps.runIsolated(prompt);
    const durationMs = Date.now() - startMs;

    if (outcome.status !== "ok" || !outcome.summary) {
      emitHeartbeatEvent({
        status: outcome.status === "ok" ? "ok-empty" : "failed",
        durationMs,
        reason: agent.agentId,
      });
      return outcome;
    }

    const ackMaxChars = agent.config.ackMaxChars ?? DEFAULT_HEARTBEAT_ACK_MAX_CHARS;
    const stripped = stripHeartbeatToken(outcome.summary, { maxAckChars: ackMaxChars });

    if (stripped.shouldSkip) {
      emitHeartbeatEvent({ status: "ok-token", durationMs, reason: agent.agentId });
      return outcome;
    }

    const target = agent.config.target;
    if (target && deps.deliver) {
      const deliveryText = stripped.didStrip ? stripped.text : outcome.summary;

      // Duplicate suppression per agent
      const prev = dedupeState.get(agent.agentId);
      const isDuplicate =
        prev !== undefined &&
        deliveryText.trim() === prev.text.trim() &&
        nowMs - prev.atMs < DEDUPE_WINDOW_MS;

      if (!isDuplicate) {
        await deps.deliver(target, deliveryText);
        dedupeState.set(agent.agentId, { text: deliveryText, atMs: nowMs });
        emitHeartbeatEvent({
          status: "sent",
          durationMs,
          preview: deliveryText.slice(0, 80),
          reason: agent.agentId,
          channel: target.channel,
        });
      }
    } else {
      emitHeartbeatEvent({ status: "sent", durationMs, reason: agent.agentId });
    }

    return outcome;
  }

  async function runOnce(agentId?: string): Promise<CronRunOutcome> {
    if (executing) {
      return { status: "skipped", error: "Already executing" };
    }

    executing = true;
    try {
      if (agentId) {
        const agent = agents.find((a) => a.agentId === agentId);
        if (!agent) {
          return { status: "skipped", error: `Unknown agent: ${agentId}` };
        }
        const result = await runAgentOnce(agent);
        agent.lastRunMs = (deps.nowMs ?? Date.now)();
        agent.nextDueMs = agent.lastRunMs + agent.intervalMs;
        return result;
      }

      // Run all agents (first agent used as default for backward compat)
      const firstAgent = agents[0];
      if (!firstAgent) {
        return { status: "skipped", error: "No agents configured" };
      }
      const result = await runAgentOnce(firstAgent);
      firstAgent.lastRunMs = (deps.nowMs ?? Date.now)();
      firstAgent.nextDueMs = firstAgent.lastRunMs + firstAgent.intervalMs;
      return result;
    } finally {
      executing = false;
    }
  }

  /** Run only due agents — used by the scheduler timer. */
  async function runDueAgents(): Promise<void> {
    if (executing) return;
    executing = true;
    try {
      const nowMs = (deps.nowMs ?? Date.now)();
      for (const agent of agents) {
        if (agent.nextDueMs <= nowMs) {
          await runAgentOnce(agent);
          agent.lastRunMs = (deps.nowMs ?? Date.now)();
          agent.nextDueMs = agent.lastRunMs + agent.intervalMs;
        }
      }
    } finally {
      executing = false;
    }
  }

  function scheduleNext() {
    if (!running) return;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }

    const nowMs = Date.now();
    let earliestDue = Infinity;
    for (const agent of agents) {
      if (agent.nextDueMs < earliestDue) {
        earliestDue = agent.nextDueMs;
      }
    }

    if (!Number.isFinite(earliestDue)) return;

    const delay = Math.max(0, earliestDue - nowMs);
    timer = setTimeout(() => {
      timer = undefined;
      void (async () => {
        await runDueAgents();
        scheduleNext();
      })();
    }, delay);
  }

  return {
    start() {
      if (running) return;
      running = true;
      agents = resolveHeartbeatAgents(config);
      scheduleNext();

      // Register wake handler
      wakeDisposer = setHeartbeatWakeHandler(async (opts) => {
        if (executing) {
          return { status: "skipped" as const, reason: "requests-in-flight" };
        }
        const result = await runOnce(opts.agentId);
        scheduleNext();
        if (result.status === "ok") {
          return { status: "ran" as const, durationMs: 0 };
        }
        if (result.status === "skipped") {
          return { status: "skipped" as const, reason: result.error ?? "skipped" };
        }
        return { status: "failed" as const, reason: result.error ?? "failed" };
      });
    },

    stop() {
      running = false;
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (wakeDisposer) {
        wakeDisposer();
        wakeDisposer = undefined;
      }
    },

    runOnce,

    isRunning() {
      return running;
    },

    updateConfig(newConfig: HeartbeatConfig) {
      const oldAgents = agents;
      config = newConfig;
      agents = resolveHeartbeatAgents(newConfig);

      // Preserve lastRunMs for agents that survived the config change
      for (const newAgent of agents) {
        const old = oldAgents.find((a) => a.agentId === newAgent.agentId);
        if (old?.lastRunMs) {
          newAgent.lastRunMs = old.lastRunMs;
          newAgent.nextDueMs = old.lastRunMs + newAgent.intervalMs;
        }
      }

      if (running) {
        scheduleNext();
      }
    },
  };
}
