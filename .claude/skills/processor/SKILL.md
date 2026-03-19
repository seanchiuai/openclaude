---
name: processor
description: Background job processing with nuxt-processor module, BullMQ queues, and Redis/Valkey-backed workers. Use when creating new background jobs, modifying existing queues (auto-spark, regenerate-embeddings, reprocess-portfolio-item, whatsapp-sync, demo-analytics), debugging worker failures, or optimizing job processing. Covers defineQueue/defineWorker patterns, job lifecycle, and Bull Board monitoring. Do NOT use for real-time streaming (use real-time skill) or deployment config (use deployment skill).
---

# Background Job Processing

This project uses [nuxt-processor](https://aidanhibbard.github.io/nuxt-processor/) for scalable background job processing with BullMQ and Redis.

**Docs**: https://aidanhibbard.github.io/nuxt-processor/getting-started.html

## Architecture Overview

```
Nuxt App (web service)
  |-> defineQueue() registers queues with Redis
  |-> queue.add() enqueues jobs

Processor Worker (separate process)
  |-> node .output/server/workers/index.mjs
  |-> defineWorker() processes jobs from queues
  |-> Runs on dedicated DO worker instance
```

Workers run in a **separate Node process** from the web server, providing isolation and scalability.

## Configuration

Redis connection in `nuxt.config.ts`:

```ts
export default defineNuxtConfig({
  modules: ['nuxt-processor'],
  processor: {
    redis: {
      // URL takes precedence over host/port fields
      url: process.env.NUXT_REDIS_URL,
      lazyConnect: true,
      maxRetriesPerRequest: null,
    },
  },
})
```

**Important**: Use `url` directly - nuxt-processor handles parsing at runtime. Don't manually parse the URL at build time.

## Defining Queues

Create `server/queues/<name>.ts`:

```ts
import { defineQueue } from '#processor'

type JobData = { sparkId: string; userId: string }
type JobResult = { success: boolean }

export default defineQueue<JobData, JobResult>({
  name: 'auto-spark',
})
```

## Defining Workers

Create `server/workers/<name>.ts`:

```ts
import { defineWorker } from '#processor'
import type { Job } from '#bullmq'

export default defineWorker({
  name: 'auto-spark',
  async processor(job: Job) {
    const { sparkId, userId } = job.data
    // Process the job...
    return { success: true }
  },
  options: {
    concurrency: 5,
  },
})
```

## Enqueuing Jobs

From any server route or utility:

```ts
import autoSparkQueue from '~/server/queues/auto-spark'

await autoSparkQueue.add('job-name', {
  sparkId: '...',
  userId: '...',
})
```

## Project Queues & Workers

| Queue | Worker | Purpose |
|-------|--------|---------|
| `auto-spark` | `auto-spark.ts` | Automated spark data collection |
| `demo-analytics` | `demo-analytics.ts` | Demo analytics processing |
| `regenerate-embeddings` | `regenerate-embeddings.ts` | Re-embed portfolio items |
| `reprocess-portfolio-item` | `reprocess-portfolio-item.ts` | Reprocess portfolio items |
| `watch-knowledge-items` | `watch-knowledge-items.ts` | Monitor knowledge items |
| `whatsapp-sync` | `whatsapp-sync.ts` | WhatsApp message sync |

## Running Workers

**Development**:
```bash
npm run processor:dev
# or
node .nuxt/dev/workers/index.mjs
```

**Production** (DigitalOcean):
- Workers run via the `processor` worker service
- Command: `node .output/server/workers/index.mjs`
- Separate instance from web service

## Bull Board UI

Monitor queues at `/bull-board` (requires auth). See `server/handlers/bull-board.ts`.

## Key Files

| File | Purpose |
|------|---------|
| `server/queues/*.ts` | Queue definitions |
| `server/workers/*.ts` | Worker processors |
| `server/handlers/bull-board.ts` | Bull Board UI setup |
| `nuxt.config.ts` | Redis connection config |

## Troubleshooting

### Redis Connection Issues
- Ensure `NUXT_REDIS_URL` env var is set at runtime
- Use `rediss://` for TLS connections (DigitalOcean managed databases)
- Check `lazyConnect: true` is set to avoid build-time connections

### #processor Import Errors
- The `#processor` alias is provided by nuxt-processor module
- During prerender, use the stub at `server/utils/processor-stub.mjs`
- Nitro alias configured in `nuxt.config.ts` for prerender compatibility

### Workers Not Processing
- Verify worker process is running separately from web server
- Check Redis connectivity in worker logs
- Ensure queue name matches between `defineQueue` and `defineWorker`
