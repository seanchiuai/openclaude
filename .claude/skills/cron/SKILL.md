---
name: cron
description: Croner-based job scheduling with heartbeat, isolated sessions, and channel delivery
---

# Cron - Job Scheduling & Heartbeat

Schedule recurring and one-time jobs, run them in isolated Claude sessions, and deliver results to channels.

## When to Use This Skill

- Adding or modifying cron job types
- Working with the heartbeat system
- Changing job execution or delivery behavior
- Debugging scheduling or timer issues

## Key Files

- `src/cron/service.ts` - Main CronService with timer management
- `src/cron/schedule.ts` - Next run time calculation
- `src/cron/store.ts` - Persist jobs.json
- `src/cron/heartbeat.ts` - Periodic system checks
- `src/cron/types.ts` - Job and schedule types

## Architecture

### Schedule Types

```typescript
type CronSchedule =
  | {kind: "at"; atMs: number; timezone?}        // one-time
  | {kind: "every"; everyMs: number; anchorMs?}   // interval
  | {kind: "cron"; expr: string; timezone?}       // cron expression (Croner syntax)
```

### Job Lifecycle

```
add(job) → persisted to jobs.json → timer armed
  → timer fires → submit to process pool (isolated session)
  → Claude completes → deliver result to target channel
  → rearm timer (if recurring)
```

### Key Details

- Timer-based: rearms every 60 seconds (MAX_TIMER_DELAY_MS)
- FIFO execution — no concurrent job runs
- Auto-delivery of results to Telegram/Slack if target specified
- Isolated sessions: each job spawns a separate Claude process
- Jobs persisted to `~/.openclaude/cron/jobs.json`
- Uses structured logger (`createLogger("cron")`) — logs job execution, stuck jobs, and load failures to `~/.openclaude/logs/gateway.log`

### CronJob Interface

```typescript
interface CronJob {
  id: string;
  name: string;
  schedule: CronSchedule;
  prompt: string;
  target?: CronDeliveryTarget;
  sessionTarget: "main" | "isolated";
  enabled: boolean;
  state: {nextRunAtMs?, lastRunAtMs?, lastStatus?, lastError?};
}
```

## OpenClaw Reference

**Cron was extracted from OpenClaw.** When adding features or fixing bugs, check the upstream first.

**Source:** `openclaw-source/src/cron/`

| OpenClaw File | OpenClaude File | Notes |
|---------------|-----------------|-------|
| `service/service.ts` | `src/cron/service.ts` | Simplified — removed lane management, failure alerts |
| `schedule.ts` | `src/cron/schedule.ts` | Direct port |
| `store.ts` | `src/cron/store.ts` | Simplified — removed store migration |
| `delivery.ts` | — | Complex multi-channel delivery |
| `isolated-agent/` | — | Full isolated agent with Pi runtime |
| `heartbeat-policy.ts` | `src/cron/heartbeat.ts` | Simplified |
| `stagger.ts` | — | Job staggering for load distribution |
| `run-log.ts` | — | Execution history tracking |
| `session-reaper.ts` | — | Session cleanup |

**Copy-first workflow:**
1. Find the feature in `openclaw-source/src/cron/`
2. Copy the implementation
3. Strip OpenClaw-specific deps (Pi runtime, isolated-agent directory, lane delivery, store migrations)
4. Replace Pi agent spawning with Claude Code subprocess via process pool
5. Rename any "openclaw" references to "openclaude"
