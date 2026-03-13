export type CronScheduleKind = "at" | "every" | "cron";

export type CronSchedule =
  | { kind: "at"; atMs: number; timezone?: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; timezone?: string };

export type CronSessionTarget = "main" | "isolated";

export type CronDeliveryTarget = {
  channel: "telegram" | "slack";
  chatId: string;
};

export interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  prompt: string;
  target?: CronDeliveryTarget;
  sessionTarget: CronSessionTarget;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  state: CronJobState;
}

export interface CronJobState {
  nextRunAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronRunStatus;
  lastError?: string;
  consecutiveErrors?: number;
  runningAtMs?: number;
}

export type CronRunStatus = "ok" | "error" | "skipped";

export interface CronRunOutcome {
  status: CronRunStatus;
  error?: string;
  summary?: string;
  durationMs?: number;
}

export interface CronStore {
  version: number;
  jobs: CronJob[];
}
