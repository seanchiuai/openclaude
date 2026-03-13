import { readFileSync, existsSync } from "node:fs";
import type { CronDeliveryTarget, CronRunOutcome } from "./types.js";

export interface HeartbeatConfig {
  enabled: boolean;
  every: number;
  checklistPath: string;
  target?: CronDeliveryTarget;
}

export interface HeartbeatDeps {
  runIsolated: (prompt: string) => Promise<CronRunOutcome>;
  deliver?: (target: CronDeliveryTarget, text: string) => Promise<void>;
}

export interface HeartbeatRunner {
  start(): void;
  stop(): void;
  runOnce(): Promise<CronRunOutcome>;
  isRunning(): boolean;
}

export function isHeartbeatOk(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  if (normalized === "heartbeat ok") return true;
  if (normalized === "heartbeat: ok") return true;
  if (normalized === "all good") return true;
  if (normalized.startsWith("heartbeat ok")) return true;
  return false;
}

export function createHeartbeatRunner(
  config: HeartbeatConfig,
  deps: HeartbeatDeps,
): HeartbeatRunner {
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let executing = false;

  async function runOnce(): Promise<CronRunOutcome> {
    if (executing) {
      return { status: "skipped", error: "Already executing" };
    }

    executing = true;
    try {
      if (!existsSync(config.checklistPath)) {
        return { status: "skipped", error: "Checklist file not found" };
      }

      const content = readFileSync(config.checklistPath, "utf-8").trim();
      if (content.length === 0) {
        return { status: "skipped", error: "Checklist is empty" };
      }

      const prompt = [
        "You are running a periodic heartbeat check.",
        "Review the following checklist and report any issues.",
        'If everything looks good, respond with exactly "heartbeat ok".',
        "",
        content,
      ].join("\n");

      const outcome = await deps.runIsolated(prompt);

      if (
        outcome.status === "ok" &&
        outcome.summary &&
        config.target &&
        deps.deliver &&
        !isHeartbeatOk(outcome.summary)
      ) {
        await deps.deliver(config.target, outcome.summary);
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
