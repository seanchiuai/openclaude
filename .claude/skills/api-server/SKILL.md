---
name: api-server
description: Nuxt 3 server API routes, middleware, agents, background queues, MCP server, voice pipelines, and server utilities. Use when creating new API endpoints, modifying server middleware, working with the agent runtime, adding server utils, or debugging API errors. Covers route conventions (GET/POST/PUT/DELETE), auth middleware, error handling, and Nitro server architecture. Do NOT use for background job processing (use processor skill) or database schema changes (use database skill).
---

# API & Server

Nuxt 3 server engine (Nitro + H3) powering the Minds AI platform. Handles authentication, AI agent orchestration, real-time streaming, background job processing, MCP protocol, voice pipelines, and third-party integrations.

## Architecture

- **Framework**: Nitro server engine with H3 request handlers
- **Auth**: Supabase Auth (cookie + Bearer token) + API key auth (`minds_` prefix, legacy `aox_`) + OAuth 2.1 (MCP/ChatGPT)
- **Database**: Prisma ORM with PostgreSQL (singleton client in `server/utils/prisma.ts`)
- **AI**: Vercel AI SDK (`streamText`/`generateObject`/`generateText`) with OpenAI, Anthropic, Google providers
- **Observability**: Langfuse via OpenTelemetry (`@langfuse/tracing` + `@langfuse/otel`)
- **Queues**: BullMQ (Redis-backed) with `nuxt-processor` module (`defineQueue`/`defineWorker`)
- **Real-time**: SSE via H3 `createEventStream`, WebSockets via `crossws` (`defineWebSocketHandler`)
- **Prompt management**: Langfuse prompts with local `.md` file fallbacks, TTL-based cache in `langfuse-prompts.ts`

## Middleware Chain

All middleware lives in `server/middleware/`. Global middleware (`.global.ts` suffix) runs on every request. Named middleware runs only on matching paths.

| File | Scope | Purpose |
|------|-------|---------|
| `domain-redirect.global.ts` | Global | 301 redirect `art-of-x.com` -> `getminds.ai` |
| `cors-native.global.ts` | Global, `/api/` | CORS headers for Capacitor/Ionic native apps (`capacitor://`, `ionic://`) |
| `api-observability.global.ts` | Global | Initializes Langfuse OTel via `@langfuse/tracing` v4 SDK (`startActiveObservation`/`updateActiveTrace`), creates session cookie (`minds_langfuse_session`, reads legacy `aox_langfuse_session`), injects `event.context.trace()` helper |
| `auth-bearer.ts` | `/api/` | Extracts Bearer token from Authorization header, validates via Supabase, sets `event.context.user` and `event.context._token` |
| `api-auth.ts` | `/api/v1/` and `/v1/` | V1 API auth: tries internal auth (`x-internal-auth` + `x-user-id` from localhost), then Supabase session, then API key (`minds_*` / legacy `aox_*` with hash verification), then OAuth token. Throws 401 if no valid auth (except api-keys and google-chat endpoints) |
| `api-subdomain.ts` | `api.getminds.ai` / `api.art-of-x.com` host | Routes API subdomain requests: allows `/v1/`, `/mcp`, `/.well-known/`, `/oauth/`; redirects GET `/v1/*` to `/api/v1/*` (307); rewrites non-GET `/v1/*` internally |
| `portfolio-auth.ts` | `/api/portfolio/` | Resolves user's team membership, attaches `event.context.userId` and `event.context.teamId` |

## API Route Structure

All routes use Nuxt file-based routing in `server/api/`. HTTP method is the file suffix (`.get.ts`, `.post.ts`, etc.).

### `server/api/auth/` — Authentication
- `check-email.post` — Check if email exists
- `confirm-email.post` — Confirm email verification
- `confirm-password-reset.post` — Complete password reset
- `create-profile.post` — Create user profile after signup
- `custom-signup.post` — Custom signup flow
- `reset-password.post` — Initiate password reset

### `server/api/spark/` — Spark (AI persona) management
- `index.get` / `index.post` / `index.delete` — List, create, bulk delete sparks
- `[id].get` / `[id].put` / `[id].patch` / `[id].delete` — CRUD single spark
- `messages.post` — **Main chat endpoint**: streams AI response via SSE (uses `runAgentCompletion`, subject to chat rate limiting — 30/min authenticated, 10/min public)
- `create-from-input.post` — Create spark from natural language input
- `collect-data.post` / `collect-data-demo.post` — Trigger data collection (dispatches `auto-spark` queue job)
- `generate-profile.post` / `generate-prompt-component.post` / `profile-image.post` — AI-powered generation
- `progress/[sparkId]/stream.get` — SSE stream for pipeline progress (uses `progressEventBus`)
- `pipeline-status/[sparkId].get` / `collection-status/[sparkId].get` — Polling status endpoints
- `share.put` / `shared/[shareId].get` — Public link sharing
- `favorites.get` / `favorites.post` / `favorites.delete` — Favorite sparks
- `search-sources.post` — Search for training sources
- `[id]/chat-history.get` / `[id]/chat-history.post` — Chat history CRUD
- `[id]/invite/index.post` / `[id]/members/*` / `[id]/invitations/*` — Collaboration
- `[id]/sms-number.get` / `[id]/sms-number.post` — Twilio phone number assignment
- `[id]/regenerate-embeddings.post` — Dispatches `regenerate-embeddings` queue job
- `[id]/profile-image*.ts` — Profile image upload (signed URL flow)

### `server/api/flows/` — Flow (multi-spark conversation) management
- `index.get` / `index.post` / `index.delete` — List, create, bulk delete
- `[id]/index.get` / `[id]/index.put` / `[id]/index.delete` — CRUD single flow
- `[id]/messages/index.get` / `[id]/messages/index.post` — Get/send messages (POST streams AI via SSE with rate limiting — 30/min per user)
- `[id]/messages/summary.post` — Generate conversation summary
- `[id]/stream.get` — **SSE endpoint** for real-time flow updates (uses `broadcast.ts` connection registry)
- `[id]/sparks/*` — Manage sparks within a flow
- `[id]/ideas/*` — Idea CRUD with comments, images, feedback, promotion
- `[id]/guided/*` — Guided curator: keyword generation, selection, curator agent
- `[id]/board.ts` / `[id]/board/image.post` — Board state management
- `[id]/cancel.post` / `[id]/typing.post` — Cancel generation, typing indicators
- `[id]/invite/*` / `[id]/members/*` — Flow collaboration
- `shared/[shareId].get` / `shared/[shareId]/stream.get` — Public shared flows

### `server/api/v1/` — Versioned Public API (API key / OAuth auth via `api-auth.ts` middleware)
- `api-keys/index.get` / `index.post` / `[keyId].delete` — API key management (requires subscription)
- `auth/me.get` — Current user info
- `sparks/index.get` / `index.post` — List/create sparks
- `sparks/[sparkId].put` / `[sparkId].delete` — Update/delete spark
- `sparks/[sparkId]/completion.post` — **Chat completion** (streams JSON response with citations)
- `sparks/[sparkId]/knowledge/*` — Knowledge items CRUD and patterns
- `sparks/[sparkId]/regenerate-prompt.post` — Regenerate system prompt
- `google-chat/webhook.post` — Google Chat bot integration
- `user/shareable-sparks.get` — List shareable sparks

### `server/api/billing/` — Stripe integration
- `checkout.post` / `portal.post` / `session.get` / `subscription.get` — Checkout, portal, session info
- `academic.post` — Academic plan application
- `webhook.post` — Stripe webhook handler (raw body, signature verification via `readRawBody`)

### `server/api/cron/` — Scheduled tasks (all protected by `Bearer {CRON_SECRET}`)
- `cleanup-stuck-jobs.post` — Fixes sparks stuck in queued/running status (every 15 min)
- `cleanup-unused-numbers.post` — Releases Twilio numbers unused for 2 weeks (daily)
- `renew-calendar-webhooks.post` — Renews Google Calendar webhook channels expiring within 2 days (daily)
- `watch-knowledge-items.post` — Checks watched links for content changes, dispatches `watch-knowledge-items` BullMQ job
- `backfill-voice-profiles.post` — Generates voiceProfiles for sparks missing them (cursor-based pagination, 50/batch)
- `validate-voice-pool.post` — Validates all Fish Audio voice IDs in the curated pool, reports invalid/expired voices
- `demo-analytics.post` — Refreshes demo analytics data via BullMQ (every 4 hours)
- `reclone-voices.post` — Triggers voice cloning for public sparks without voice clones, searches YouTube for interview videos (supports `sparkIds` filter, `includeRetry`, `dryRun` mode)
- `classify-spark-voices.post` — Migration: classifies voice gender for existing sparks
- `migrate-voice-webhooks.post` — Migration: configures voice webhooks on existing phone numbers

### Other route groups
- `server/api/team/` — Team CRUD, invitations, members, integrations
- `server/api/user/` — Profile, preferences, number lookup, delete-all
- `server/api/portfolio/` — Portfolio items CRUD, file access, processing status, retrigger
- `server/api/content/` — Content processing (items, messages, uploads)
- `server/api/notifications/` — Push notification registration, preferences, test
- `server/api/integrations/google-calendar/` — OAuth flow, status, disconnect
- `server/api/public/` — Unauthenticated: demo flow, public sparks, widget config, room info
- `server/api/chat/` — Chat history and recent messages
- `server/api/email/` — Email preferences, digest cron, test send
- `server/api/health/` — Health checks (general, content-processor, data-collector)
- `server/api/webhooks/google-calendar.post` — Google Calendar push notifications
- `server/api/voice/` — `transcribe.post` (Deepgram STT), `webhook.post` (Twilio voice webhook)
- `server/api/sms/webhook.post` / `server/api/whatsapp/webhook.post` — Twilio SMS/WhatsApp inbound
- `server/api/trainer/message.post` — Trainer agent chat endpoint
- `server/api/evaluate/reliability.post` — Evaluator agent for response reliability scoring
- `server/api/patterns/` — Pattern analysis endpoints
- `server/api/competencies/` — Competency framework data
- `server/api/widgets/spark.get` — Widget embed configuration
- `server/api/admin/` — Demo analytics, spark analytics, user analytics
- `server/api/uploads/` — Signed URL generation, upload confirmation
- `server/api/geo/currency.get` — Geo-based currency detection
- `server/api/generated-images/` — Proxy for generated image assets
- `server/api/preview/og.get` — Open Graph preview generation
- `server/api/context/search-sources.post` — Context source search
- `server/api/oauth/validate-token.post` — OAuth token validation
- `server/api/debug/auth-check.get` — Debug auth state check

## Non-API Routes (`server/routes/`)

- `mcp.ts` — MCP protocol handler at `/mcp` (StreamableHTTP transport, rate limiting, circuit breakers)
- `bull-board.ts` + `bull-board/[...].ts` — Bull Board UI at `/bull-board` (Basic auth via runtime config)
- `oauth/authorize.get` / `callback.get` / `token.post` / `register.post` — OAuth 2.1 + PKCE for MCP clients (ChatGPT, Claude Desktop, Cursor)
- `.well-known/oauth-authorization-server.get` / `oauth-protected-resource.get` / `openid-configuration.get` — OAuth/OIDC discovery
- `api/voice/stream.ts` — **WebSocket**: Twilio Media Streams voice bridge (mulaw 8kHz <-> PCM 24kHz)
- `api/voice/browser-stream.ts` — **WebSocket**: Browser voice mode (PCM16 24kHz, JSON control messages)
- `v1/sparks/[sparkId]/completion.post` — V1 completion (alternate route path)
- `widget/spark.html.get` — Embeddable widget HTML
- `sitemap.xml.ts` — Dynamic sitemap generation
- `admin/auth.ts` / `callback.ts` / `config.yml.ts` — Admin CMS (Decap CMS) auth

## Handler Patterns

### Authenticated GET with router params
```ts
export default defineEventHandler(async (event) => {
  const user = await requireAuthenticatedUser(event) // from server/utils/auth.ts
  const id = getValidatedRouterParam(event, 'id', 'Spark ID') // UUID validation
  const spark = await prisma.spark.findUnique({ where: { id } })
  if (!spark) throw createError({ statusCode: 404, statusMessage: 'Spark not found' })
  return spark
})
```

### POST with body and observability tracing
```ts
export default defineEventHandler(async (event) => {
  const user = await requireAuthenticatedUser(event)
  const body = await readBody(event)
  if (!body.sparkId) throw createError({ statusCode: 400, statusMessage: 'sparkId is required' })
  return await event.context.trace('spark-message', async () => {
    // AI agent call inside trace
    return await runAgentCompletion({ event, ... })
  }, { sparkId: body.sparkId, userId: user.id, agentType: 'spark' })
})
```

### SSE streaming response
```ts
export default defineEventHandler(async (event) => {
  setHeader(event, 'Content-Type', 'text/event-stream; charset=utf-8')
  setHeader(event, 'Cache-Control', 'no-cache, no-store, must-revalidate, no-transform')
  setHeader(event, 'Connection', 'keep-alive')
  setHeader(event, 'X-Accel-Buffering', 'no')
  setHeader(event, 'Content-Encoding', 'none')
  // Use createEventStream or manual write via event.node.res.write()
})
```

### Webhook with raw body (Stripe pattern)
```ts
export default defineEventHandler(async (event) => {
  const body = await readRawBody(event, 'utf8')
  const sig = getRequestHeader(event, 'stripe-signature')
  const stripeEvent = stripe.webhooks.constructEvent(body, sig, webhookSecret)
  // handle event...
})
```

### Cron job with secret verification
```ts
export default defineEventHandler(async (event) => {
  const authHeader = getHeader(event, 'authorization')
  if (authHeader !== `Bearer ${useRuntimeConfig().cronSecret}`) {
    throw createError({ statusCode: 401, statusMessage: 'Unauthorized' })
  }
  // run cron logic...
})
```

## Agent System (`server/agents/`)

The agent runtime (`runtime.ts`) provides `runAgentCompletion()` — the central function for all AI interactions. It:
1. Fetches prompt config from Langfuse (model, temperature, maxTokens, provider)
2. Creates the AI provider (OpenAI, Anthropic, or Google via Vercel AI SDK)
3. Calls `streamText()` with tools, system prompt, messages, and abort signal
4. Records generation observations to Langfuse

| Agent | File | Purpose |
|-------|------|---------|
| `runtime` | `runtime.ts` | Core agent runner: `runAgentCompletion()` with multi-provider support, tool execution, Langfuse tracing |
| `spark` | `spark.ts` | Generates spark system prompts from Langfuse templates with temporal context |
| `flow` | `flow.ts` | Generates flow context prompts and moderator prompts for multi-spark conversations |
| `idea` | `idea.ts` | Generates idea context prompts for idea refinement within flows |
| `trainer` | `trainer.ts` | Trainer agent with DB query, RAG, portfolio, and web search tools |
| `evaluator` | `evaluator.ts` | Scores AI response reliability (0-100) against the spark's system prompt |
| `guidedCurator` | `guidedCurator.ts` | Curates guided flow sessions, suggests spark participants |
| `content-filter` | `content-filter.ts` | LLM-based content relevance filtering (multi-provider) |
| `pattern-analyzer` | `pattern-analyzer.ts` | Analyzes content for thinking/behavioral patterns using frameworks |

## Tool Orchestrator (`server/utils/tool-orchestrator.ts`)

`getToolsForContext()` returns the appropriate tool set based on context:
- **SPARK_CHAT_TOOLS**: RAG, image generation, web search, display image, document processing, link analysis
- **TRAINER_CHAT_TOOLS**: RAG, web search, link analysis, document processing, image display + portfolio management, training content, system prompt editing, user preferences
- **FLOW_CHAT_TOOLS**: Similar to spark tools
- **IDEA_AGENT_TOOLS**: RAG, idea CRUD, comments, images, endorsement

Tool implementations live in `server/utils/tools/`: `rag.ts`, `web.ts`, `image.ts`, `db.ts`, `chat.ts`, `portfolio.ts`, `file.ts`, `spark.ts`, `idea.ts`, `user.ts`.

## Queue System (BullMQ)

Queues are defined in `server/queues/` using `defineQueue({ name })` from `nuxt-processor`. Workers are in `server/workers/` using `defineWorker({ name, processor, options })`. All use Redis connection from environment.

| Queue | Worker | Concurrency | Purpose |
|-------|--------|-------------|---------|
| `auto-spark` | `auto-spark.ts` | 2 | Data collection pipeline: scrapes sources, generates embeddings/patterns, classifies voice, attempts voice cloning from YouTube |
| `regenerate-embeddings` | `regenerate-embeddings.ts` | 1 | Batch re-embeds all portfolio items + existing embeddings using `text-embedding-3-large` (1536 dims). Handles SIGTERM gracefully |
| `reprocess-portfolio-item` | `reprocess-portfolio-item.ts` | 1 | Re-processes a single portfolio item (embeddings + patterns) |
| `demo-analytics` | `demo-analytics.ts` | 1 | Runs demo analytics aggregation |
| `watch-knowledge-items` | `watch-knowledge-items.ts` | 1 | Checks watched portfolio items for content changes (social profiles via Apify, links via Tavily), queues reprocessing if updated |
| `whatsapp-sync` | `whatsapp-sync.ts` | 2 | Syncs spark profile to Twilio WhatsApp sender, polls for ONLINE status |
| `concept-feedback` | *(uses conceptFeedbackQueue.ts util)* | — | Queues concept feedback processing |

**Worker Prisma Pattern**: Workers must lazy-load Prisma via `const { prisma } = await import('~/server/utils/prisma')` to prevent DATABASE_URL initialization crashes at startup. Top-level imports are not supported in workers.

**Bull Board UI**: Available at `/bull-board` with Basic auth (`runtimeConfig.bullboard.username/password`). Configured in `server/handlers/bull-board.ts`.

**Job dispatch pattern**:
```ts
import autoSparkQueue from '~/server/queues/auto-spark'
await autoSparkQueue.add('collect', { sparkId, userId, entityNames, ... })
```

## MCP Server (`server/mcp/`)

Model Context Protocol server for external AI clients (ChatGPT, Claude Desktop, Cursor).

- **Transport**: StreamableHTTP via `@modelcontextprotocol/sdk`, session-based (session ID in headers)
- **Auth**: Bearer API key (`minds_*` / legacy `aox_*`) or OAuth 2.1 with PKCE
- **Route**: `/mcp` (handled by `server/routes/mcp.ts`)
- **Tools**: `list_my_ai_personas`, `create_ai_persona_or_digital_twin`, `talk_to_ai_persona`, `check_ai_persona_training_progress`
- **Resources**: `ai-persona-widget` (`sparkWidget.ts` — unified widget for creation and chat modes, loaded via `widgetLoader.ts`)
- **Middleware**: Rate limiting (`server/mcp/middleware/rateLimit.ts`), CORS (`config.ts`)
- **Utilities**: Circuit breakers, audit logging, metrics, error codes, fuzzy matching, token/cache management, validation
- **Standalone**: Session-based HTTP server (`main.ts`), stateless HTTP server (`http.ts`), stdio (`stdio.ts` + `stdioServer.ts`)

## Voice Pipeline

Real-time voice conversations via STT -> LLM -> TTS pipeline.

- **Orchestrator** (`server/utils/voice/orchestrator.ts`): Manages single voice session lifecycle
- **STT**: Deepgram streaming (`server/utils/voice/deepgram-stt.ts`)
- **TTS**: Fish Audio streaming (`server/utils/voice/fish-audio-tts.ts`)
- **Twilio bridge** (`server/routes/api/voice/stream.ts`): WebSocket for phone calls (mulaw 8kHz <-> PCM 24kHz conversion via `audio-convert.ts`)
- **Browser bridge** (`server/routes/api/voice/browser-stream.ts`): WebSocket for browser voice mode (PCM16 24kHz)
- **Voice cloning** (`server/utils/voice-cloning/`): YouTube audio extraction, speaker identification, voice cloning
- **Voice classifier** (`server/utils/voice-classifier.ts`): Classifies spark voice gender, assigns default voice IDs

## Server Utilities Catalog (`server/utils/`)

| Utility | Purpose |
|---------|---------|
| `auth.ts` | `getAuthenticatedUser()`, `requireAuthenticatedUser()`, `ensureUserProfile()` — Bearer + cookie auth, skips `minds_`/`aox_` API key tokens |
| `spark-auth.ts` | `determineSparkAccess()` — granular access control (owner, collaborator, public, session) |
| `validation.ts` | `validateAuthenticatedUser()`, `validateEmail()`, `validateUUID()`, `getValidatedRouterParam()`, `handleApiError()` |
| `prisma.ts` | Singleton PrismaClient with global caching in dev, no-op proxy client during Nitro prerender |
| `subscription-guard.ts` | `requireSubscription()` — enforces plan check (premium/lite/academic/team) |
| `broadcast.ts` | In-memory SSE connection registry for flows (`addFlowConnection`/`removeFlowConnection`/`broadcastMessageToFlow`) |
| `progress-event-bus.ts` | In-memory pub/sub for spark pipeline progress updates (SSE) |
| `langfuse-prompts.ts` | Prompt loading from Langfuse with TTL cache + local `.md` fallback. `MAX_CACHE_SIZE` pattern |
| `tool-orchestrator.ts` | `getToolsForContext()` — returns tool sets by context type with Langfuse observation recording |
| `ai-helpers.ts` | `isReasoningModel()` — checks if model supports reasoning |
| `embeddings.ts` | OpenAI embedding creation (`text-embedding-3-large`) |
| `content-processor.ts` | Processes portfolio items: extracts text, generates embeddings + patterns |
| `stripe.ts` | Stripe client, plan resolution, checkout session creation |
| `email.ts` | Email sending (daily digest, notifications) |
| `twilio.ts` | Twilio phone number management, SMS/WhatsApp/voice webhook handling |
| `image-generation.ts` | AI image generation (DALL-E, Flux) |
| `image-storage.ts` | Supabase Storage image upload/management |
| `image-analysis.ts` | Vision API image analysis |
| `face-detection.ts` | Face detection for profile images |
| `social-scraper.ts` | Social media profile scraping (Apify) |
| `social-content-processor.ts` | Processes scraped social content into portfolio items |
| `seo-keywords.ts` | SEO keyword extraction and analysis |
| `competitor-analysis.ts` | Competitive analysis for sparks |
| `chat-rate-limiter.ts` | `checkChatRateLimit()` — sliding-window rate limiting for chat endpoints (per-user or per-IP, operation-type specific limits: spark_chat/flow_chat 30/min, trainer/idea 20/min, unauthenticated 10/min; returns 429 with `Retry-After` and `X-RateLimit-*` headers) |
| `context-compression.ts` | Compresses conversation context to stay within token limits |
| `context-documents.ts` | Builds context document summaries for guided flows |
| `flow-conversation.ts` | Flow message handling, tool metadata parsing |
| `flow-moderator.ts` | Determines next speaker in multi-spark flows |
| `flow-name-generator.ts` | AI-generated flow names |
| `spark-creation.ts` | Spark creation logic (from input, from demo) |
| `spark-profile.ts` | Spark profile generation (system prompt, description) |
| `spark-shaping.ts` | Spark shaping utilities |
| `spark-avatar.ts` | Profile image generation for sparks |
| `sparks.ts` | Spark query utilities |
| `generate-prompt-components.ts` | Generates individual prompt components (bio, style, expertise) |
| `generateEditSummary.ts` | Summarizes edits to spark system prompts |
| `frameworks.ts` | Thinking framework aspects/sub-aspects (loaded from `server/data/frameworks.json`) |
| `sparkThinkingAspects.ts` | Builds thinking aspects section for spark prompts |
| `ideaFeedback.ts` | Idea feedback processing |
| `conceptFeedbackQueue.ts` | BullMQ-based concept feedback processing |
| `board-state.ts` | Flow board state management |
| `demo-flow.ts` | Demo flow creation and management |
| `demo-analytics.ts` | Demo analytics aggregation |
| `analytics.ts` | Event tracking (PostHog/Langfuse) |
| `crypto.ts` | `hashKey()`, `verifyKey()` — API key hashing |
| `validateOAuthToken.ts` | OAuth token validation |
| `locale.ts` | Language detection, user locale, language instructions |
| `geo.ts` | Geo-based currency detection |
| `push.ts` | Web push notification sending |
| `team.ts` | Team creation/management utilities |
| `user-preferences.ts` | User preference storage |
| `citations.ts` | Maps RAG/web sources to citation objects |
| `tool-labels.ts` | Localized tool display labels |
| `pipeline-status.ts` | `updateSparkPipelineStatus()` — writes pipeline status to DB |
| `terminal-progress.ts` | Terminal progress display for CLI tools |
| `portfolio-processor.ts` | Portfolio item processing pipeline |
| `rag.ts` | RAG retrieval utilities |
| `google-calendar-*.ts` | Google Calendar OAuth, sync, webhook, enrichment, event updates |
| `google-chat.ts` | Google Chat bot message handling |
| `plugins/convoy.ts` | Convoy A/B testing integration (gated by env vars) |
| `widgets/` | Embeddable widget generation (Vue app, styles, sphere graph) |
| `data-collection/` | Full data collection pipeline: search (Tavily, YouTube/Apify), content processing, chunking, embedding generation, pattern extraction, quality filtering, spark generation |
| `voice-cloning/` | Voice cloning pipeline: YouTube audio extraction, speaker identification, clone voice |
| `voice/` | Voice session orchestrator, Deepgram STT, Fish Audio TTS |
| `safety-filters.ts` | Input sanitization (`sanitizeInput()`) and output validation (`validateOutput()`) for prompt injection/leakage detection |
| `agent-errors.ts` | Error classification (`classifyError()`), retry logic (`withRetry()`), per-tool timeout config (`getToolTimeout()`) |
| `conversation-memory.ts` | LLM-based rolling conversation summaries with DB persistence |
| `observability/` | Langfuse initialization, generation recording (`recordGenerationObservation`), error event recording (`recordErrorEvent`), demo funnel tracking (`recordDemoEvent`), evaluation queueing |

## Key Environment Variables

- `DATABASE_URL` / `DIRECT_URL` — PostgreSQL connection
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` — Supabase
- `OPENAI_API_KEY` / `OPENAI_ORG_ID` — OpenAI
- `ANTHROPIC_API_KEY` — Anthropic
- `GOOGLE_API_KEY` — Google AI
- `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` — Langfuse observability
- `STRIPE_SECRET_KEY` / `stripeWebhookSecret` — Stripe billing
- `CRON_SECRET` — Cron job authorization
- `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` — Twilio voice/SMS
- `DEEPGRAM_API_KEY` — Deepgram STT
- `FISH_AUDIO_API_KEY` — Fish Audio TTS
- `CONVOY_PROXY_URL` / `CONVOY_SECRET` — Convoy A/B testing (optional)
- `bullboard.username` / `bullboard.password` — Bull Board UI auth (runtime config)
- `demoFlowOwnerId` — Demo flow owner user ID (runtime config)

## Nitro Configuration (from `nuxt.config.ts`)

- `experimental.wasm: true` / `experimental.websocket: true` — Enable WASM and WebSocket support
- `externals.external: ['@prisma/client', '.prisma/client']` — Exclude Prisma from bundling
- **Route rules**: Disable buffering for `/api/flows/*/messages`, `/api/flows/*/stream`, `/api/public/flow-messages`, `/mcp`
- `/api/billing/webhook` has `bodyParser: false` for raw Stripe signature verification

## Related Files

- `server/api/` — All API route handlers
- `server/routes/` — Non-API routes (MCP, Bull Board, OAuth, WebSocket, widget, sitemap)
- `server/middleware/` — Server middleware (auth, CORS, observability, subdomain)
- `server/agents/` — AI agent implementations (runtime, spark, flow, idea, trainer, evaluator, etc.)
- `server/utils/` — Server utilities (auth, DB, AI, integrations, pipelines)
- `server/utils/tools/` — AI tool implementations (RAG, web, image, DB, portfolio, etc.)
- `server/utils/voice/` — Voice pipeline (orchestrator, Deepgram STT, Fish Audio TTS)
- `server/utils/voice-cloning/` — Voice cloning pipeline
- `server/utils/data-collection/` — Data collection pipeline (search, content, embeddings, patterns)
- `server/utils/observability/` — Langfuse initialization and recording
- `server/utils/widgets/` — Embeddable widget generation
- `server/queues/` — BullMQ queue definitions
- `server/workers/` — BullMQ worker implementations
- `server/handlers/` — Shared handlers (Bull Board)
- `server/mcp/` — MCP server (tools, resources, config, middleware, utilities)
- `server/data/frameworks.json` — Thinking framework definitions
- `nuxt.config.ts` — Nitro/route rules configuration
