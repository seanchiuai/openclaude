---
name: database
description: PostgreSQL database with Prisma ORM, pgvector for embeddings, and pgbouncer connection pooling. Use when modifying database schema, writing migrations, adding new Prisma models, optimizing queries, working with vector embeddings, or debugging database connection issues. Covers schema conventions, migration workflow, RLS policies, and connection management. Do NOT use for Supabase Auth specifics (use auth skill) or background job queues (use processor skill).
---

# Database

PostgreSQL (Supabase-hosted) via Prisma ORM with pgvector for vector similarity search and pgbouncer for connection pooling.

## Connection Architecture

- **`DATABASE_URL`** -- pgbouncer pooled connection (`?pgbouncer=true`), used by Prisma Client at runtime
- **`DIRECT_URL`** -- direct PostgreSQL connection, used by Prisma CLI (migrations, introspect)
- **Extensions**: `vector` (pgvector), `uuid-ossp`, `pg_trgm`
- **Client singleton**: `server/utils/prisma.ts` -- global `__prisma` in dev (survives HMR), fresh instance in production; falls back to `DIRECT_URL` if `DATABASE_URL` is unset; returns a no-op proxy during Nitro prerender (no DB available)
- **Logging**: `['warn', 'error']` in dev, `['error']` in production

```ts
import { prisma } from '~/server/utils/prisma'  // auto-imported in /server/
```

## Schema Conventions

- **camelCase fields** map to **snake_case columns** via `@map()`, tables via `@@map()`
- **IDs**: mostly `@default(uuid()) @db.Uuid`; some use `@default(cuid())` or `autoincrement()`
- **Timestamps**: `createdAt @default(now())` + `updatedAt @updatedAt`
- **Cascade deletes**: most children use `onDelete: Cascade`; some use `SetNull` (e.g., Spark.team, FlowMessage.spark)

## Complete Model Inventory (55 models)

### Core User
| Model | Table | Purpose |
|-------|-------|---------|
| `UserProfile` | `user_profiles` | User accounts (ID = Supabase Auth UID) |
| `UserPreferences` | `user_preferences` | Settings: TTS, language, voice, colors, notifications |
| `ApiKey` | `api_keys` | Hashed API keys for v1 REST API |
| `DeviceToken` | `device_tokens` | Push notification tokens (iOS/Android) |

### Spark (AI Persona)
| Model | Table | Purpose |
|-------|-------|---------|
| `Spark` | `sparks` | AI personas: system prompt, voice config, phone/WhatsApp, team sharing |
| `SparkMember` | `spark_members` | Collaborative spark membership |
| `SparkInvitation` | `spark_invitations` | Token-based spark sharing invitations |
| `SparkEmbedding` | `spark_embeddings` | Vector embeddings for RAG (`Unsupported("vector")`) |
| `SparkDendrogram` | `spark_dendrograms` | SVG/PNG dendrograms (1:1 with spark) |
| `SparkPipelineStatus` | `spark_pipeline_status` | Pipeline progress (idle/queued/running/completed/failed) |
| `SparkChatHistory` | `spark_chat_histories` | Chat messages as JSON array per spark+user |
| `SparkConversation` | `spark_conversations` | Phased project conversations (task_analysis/exploration/completed) |

### Knowledge & Training
| Model | Table | Purpose |
|-------|-------|---------|
| `PortfolioItem` | `portfolio_items` | Training data: files, links, descriptions; optionally watched |
| `Pattern` | `patterns` | Extracted competency patterns (aspect/subAspect from content) |
| `MonologueRecording` | `monologue_recordings` | Audio Q&A recordings |
| `PeerTrainingRecording` / `PeerTrainingParticipant` | `peer_training_*` | Multi-user video training (composite PK) |
| `DemographicsAnswer` | `demographics_answers` | Survey answers (unique per userId+questionKey) |
| `PipelineJob` | `pipeline_jobs` | Background processing jobs |

### Project & Output
| Model | Table | Purpose |
|-------|-------|---------|
| `Project` | `projects` | User projects |
| `ContextItem` | `context_items` | Project context (files, links, text) |
| `SparksOnProjects` | `sparks_on_projects` | Composite PK join table |
| `ProjectRun` / `ProjectRunEvent` | `project_runs/events` | Execution runs with streaming events |
| `Output` / `OutputComment` | `outputs/output_comments` | AI-generated outputs with comments |
| `Artefact` / `ArtefactComment` | `artefacts/artefact_comments` | Promoted outputs |
| `Concept` / `ConceptComment` | `concepts/concept_comments` | Versioned concepts with parent chain |

### Flow (Collaboration)
| Model | Table | Purpose |
|-------|-------|---------|
| `Flow` | `flows` | Multi-spark conversation spaces (guided/manual modes) |
| `FlowSparks` | `flow_sparks` | Composite PK join table |
| `FlowMessage` | `flow_messages` | Messages (user/assistant/system roles) |
| `FlowIdea` / `FlowIdeaComment` | `flow_ideas/comments` | Ideas with versioning and refinement chain |
| `FlowConcept` | `flow_concepts` | Synthesized concepts from discussions |
| `FlowMember` / `FlowInvitation` | `flow_members/invitations` | Membership and token-based invitations |

### Team & Chat
| Model | Table | Purpose |
|-------|-------|---------|
| `Team` | `teams` | Organizations with Stripe billing |
| `TeamMember` | `team_members` | Team membership (`@unique userId` = one team per user) |
| `TeamInvitation` | `team_invitations` | Token-based invitations |
| `TeamIntegration` | `team_integrations` | External integrations (Slack, Google Chat, widgets) |
| `ChatSession` / `ChatMessage` | `chat_sessions/messages` | Legacy chat with JSON content |
| `VoiceAgentRecording` | `voice_agent_recordings` | Voice recordings |

### OAuth & Calendar
| Model | Table | Purpose |
|-------|-------|---------|
| `OAuthClient` / `OAuthAuthorizationCode` / `OAuthAccessToken` | `oauth_*` | OAuth 2.1 for MCP/ChatGPT |
| `GoogleOAuthToken` | `google_oauth_tokens` | Google Calendar OAuth (1:1 per user) |
| `CalendarWebhookChannel` / `SyncedCalendarEvent` / `CalendarAttendeeSpark` | `calendar_*` | Calendar sync and auto-spark |

### Analytics & Misc
| Model | Table | Purpose |
|-------|-------|---------|
| `AnalyticsEvent` | `analytics_events` | GDPR-compliant anonymous events |
| `DemoAnalyticsSnapshot` | `demo_analytics_snapshots` | Periodic funnel snapshots |
| `ResidencyApplication` | `residency_applications` | Job/residency applications |

## pgvector & Embeddings

**Config**: `text-embedding-3-large` (OpenAI), 1536 dimensions, 1000-char chunks with 200-char overlap, SHA-256 dedup.

The `SparkEmbedding.embedding` column is `Unsupported("vector")?` -- all vector operations require raw SQL.

### Insert Embeddings
```ts
await prisma.$executeRaw`
  INSERT INTO spark_embeddings (spark_id, content, content_hash, source_type, source_id, embedding, metadata, created_at, updated_at)
  VALUES (${sparkId}::uuid, ${chunk}, ${contentHash}, ${sourceType}, ${sourceId},
    ${`[${embedding.join(',')}]`}::vector, ${JSON.stringify(metadata)}::jsonb, NOW(), NOW())
  ON CONFLICT (spark_id, content_hash) DO NOTHING;
`
```

### Similarity Search (cosine distance via `<=>`)
```ts
// server/utils/tools/rag.ts -- getRagChunksForSparkById
const result = await prisma.$queryRaw<any>`
  SELECT id, content, metadata, 1 - (embedding <=> ${vector}::vector) as similarity
  FROM spark_embeddings
  WHERE spark_id = ${sparkId}::uuid
  ORDER BY similarity DESC
  LIMIT ${limit};
`
```

### Delete Embeddings by Knowledge Item
```ts
await db.$executeRaw`
  DELETE FROM spark_embeddings WHERE spark_id = ${sparkId}::uuid
  AND (source_id = ${itemId} OR source_id LIKE ${itemId + '_chunk_%'})
`
```

### Source Types
`chat`, `knowledge`, `knowledge_link`, `knowledge_file`, `portfolio`, `training_chat`, `manual_entry`, `portfolio_insight`

### Alternate Insert Path
`addSparkTrainingContentTool` uses Supabase Admin client (`supabase.from('spark_embeddings').insert(...)`) to bypass RLS.

## Access Control Patterns

### Spark Access (reused across many endpoints)
```ts
where: {
  id: sparkId,
  OR: [
    { userId: user.id },
    { members: { some: { userId: user.id } } },
    { AND: [{ isSharedWithTeam: true }, { team: { members: { some: { userId: user.id } } } }] }
  ]
}
```

### Auth Middleware (`server/middleware/api-auth.ts`)
Runs on `/api/v1/` and `/v1/` routes. Checks in order: internal auth header (localhost), Supabase session, API key (`aox_*` prefix), OAuth bearer token.

### Dynamic DB Query Tool (`server/utils/tools/db.ts`)
AI-callable tool with allowlisted models (`UserProfile`, `PortfolioItem`, `ChatSession`, `ChatMessage`), auto-injected `userId` filter, stripped relation fields.

## Key Gotchas

1. **Vector columns require raw SQL** -- Never `SELECT *` from `spark_embeddings` via Prisma (P2010 deserialization error)
2. **UUID casting** -- Always `${id}::uuid` in raw SQL for UUID columns
3. **RLS bypass** -- Prisma uses service credentials; auth is application-level, not DB-level
4. **`ON CONFLICT`** -- Always include for embedding inserts to handle duplicate chunks
5. **`$executeRawUnsafe`** -- Only for DDL or dynamic column/table names; use tagged template `$executeRaw\`...\`` for parameterized queries
6. **P2023 errors** -- Corrupted UUID data in legacy tables; catch and return empty results
7. **Column renames** -- `Pattern.aspect` maps to DB column `method`, `Pattern.subAspect` maps to `competency` (preserved for migration compatibility)
8. **pgbouncer Transaction mode** -- Avoid `SET` statements or prepared statements needing Session mode
9. **Worker lazy-loading** -- BullMQ workers must lazy-load Prisma via `const { prisma } = await import('~/server/utils/prisma')` instead of top-level imports. Top-level Prisma import in workers causes `DATABASE_URL` initialization crash because worker modules are evaluated before env is ready

## Migration Workflow

```bash
npx prisma migrate dev --name describe_change  # Dev: generate + apply + regenerate client
npx prisma migrate deploy                       # Production: apply pending migrations
npx prisma generate                             # Regenerate client only
```

Vector indexes must be created manually: `CREATE INDEX ... USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);`

## Caching Pattern

TTL-based Map caches with LRU eviction (reference: `server/utils/langfuse-prompts.ts`):

```ts
const cache = new Map<string, { data: T; timestamp: number }>()
const MAX_CACHE_SIZE = 100
const CACHE_TTL = 5 * 60 * 1000
```

## Related Files

- `prisma/schema.prisma` -- Full schema (55 models)
- `prisma/seed.ts` -- Seed data script
- `server/utils/prisma.ts` -- Prisma client singleton
- `server/utils/embeddings.ts` -- Embedding creation
- `server/utils/tools/rag.ts` -- RAG retrieval + vector similarity search
- `server/utils/content-processor.ts` -- Content processing pipeline (patterns + embeddings)
- `server/utils/data-collection/embeddings/generator.ts` -- Batch embedding generator
- `server/utils/data-collection/config.ts` -- Collection config (chunk size, rate limits)
- `server/utils/tools/db.ts` -- AI-callable dynamic DB query tool
- `server/middleware/api-auth.ts` -- API authentication middleware
- `scripts/database/` -- DB utility scripts (setup, migrate, prune, compare)
