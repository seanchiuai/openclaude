---
name: ai-ml
description: AI/ML integrations including multi-provider LLM routing, embeddings, RAG pipeline, autonomous agents, Langfuse prompt management, image generation, and observability. Use when working on LLM provider config, adding new AI models, modifying the RAG/embedding pipeline, building agents, changing prompt templates, or integrating image generation providers. Do NOT use for voice-specific features (use voice skill) or frontend UI (use ui-components skill).
---

# AI/ML & LLM System

Multi-provider AI system using Vercel AI SDK with specialized agents, RAG pipeline, local prompt management (with Langfuse observability), and tool-calling agentic loops.

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    server/utils/models.ts                        │
│              (Single source of truth for model IDs)              │
└─────────────────────────────────────────────────────────────────┘
                              │
        ┌─────────────────────┼─────────────────────┐
        ▼                     ▼                     ▼
┌───────────────┐    ┌───────────────┐    ┌───────────────┐
│ ai/executor.ts │    │ runtime.ts    │    │ providers.ts  │
│ (Unified API)  │    │ (Agents)      │    │ (Singletons)  │
└───────────────┘    └───────────────┘    └───────────────┘
        │                     │                     │
        └─────────────────────┼─────────────────────┘
                              ▼
                    ┌───────────────────┐
                    │ circuit-breaker.ts │
                    │ (Health tracking)  │
                    └───────────────────┘
```

## Provider Architecture

Three LLM providers via Vercel AI SDK adapters (`@ai-sdk/openai`, `@ai-sdk/anthropic`, `@ai-sdk/google`). Two execution paths:

### Decision Tree: Which to Use?

```
Need LLM call?
│
├─ Streaming to client? ──────────────────► Agent Runtime (runAgentCompletion)
│   - Chat messages (spark, flow, idea)
│   - Real-time text generation
│   - Tool-calling agentic loops
│
├─ Structured output (JSON)? ─────────────► Unified Executor (generateObjectWithFallback)
│   - Spark profiles, evaluations
│   - Content classification
│   - Any Zod schema output
│
├─ Simple text generation? ───────────────► Unified Executor (generateTextWithFallback)
│   - Summaries, descriptions
│   - One-shot completions
│   - Background processing
│
└─ Need fallback + circuit breaker? ──────► Unified Executor
    - Provider resilience required
    - Non-streaming batch jobs
```

| Feature | Unified Executor | Agent Runtime |
|---------|------------------|---------------|
| Streaming | ✗ | ✓ |
| Tools | ✗ | ✓ |
| Provider fallback | ✓ (automatic) | ✗ (single provider) |
| Circuit breaker | ✓ | ✗ |
| Structured output | ✓ (Zod) | ✓ (Zod) |
| Prompt from file | ✗ (inline) | ✓ (prompts/*.md) |
| Langfuse tracing | ✓ (automatic) | ✓ (automatic) |

### 1. Unified AI Executor (Simple Calls)

For standalone LLM calls with automatic fallback and circuit breaker:

```typescript
import { generateObjectWithFallback, generateTextWithFallback } from '~/server/utils/ai'

const result = await generateObjectWithFallback({
  schema: mySchema,
  system: 'You are...',
  prompt: 'Generate...',
  preferredProvider: 'openai',
  tier: 'fast',  // 'fast' | 'capable' | 'reasoning'
})
```

For full control with metadata:

```typescript
import { executeObject, executeText } from '~/server/utils/ai'

const { result, provider, model, latencyMs, attempts, fallbackUsed } = await executeObject({
  schema: mySchema,
  system: 'You are...',
  prompt: 'Do...',
  preferredProvider: 'anthropic',
  tier: 'capable',
  traceName: 'my-feature:generation',  // For Langfuse
  maxRetries: 2,
  circuitBreaker: true,
  abortSignal: controller.signal,
})
```

### 2. Agent Runtime (Complex Agents)

For streaming agents with tools, uses `runAgentCompletion()` in `server/agents/runtime.ts`. Provider auto-detected from model name:

```ts
if (modelName.startsWith('claude-')) provider = 'anthropic'
else if (modelName.startsWith('gemini-')) provider = 'google'
else provider = 'openai' // default
```

## Model Constants

All model IDs are centralized in `server/utils/models.ts`:

### Text Models

```typescript
import {
  ANTHROPIC_MODELS,  // OPUS, SONNET, HAIKU
  OPENAI_MODELS,     // GPT54, GPT5_MINI, GPT4O, O3, O3_MINI, etc.
  GOOGLE_MODELS,     // GEMINI_25_PRO, GEMINI_25_FLASH, etc.
} from '~/server/utils/models'
```

| Constant | Model ID | Use Case |
|----------|----------|----------|
| `ANTHROPIC_MODELS.OPUS` | `claude-opus-4-6` | Complex reasoning, creative writing |
| `ANTHROPIC_MODELS.SONNET` | `claude-sonnet-4-6` | Default for sparks/flows |
| `ANTHROPIC_MODELS.HAIKU` | `claude-haiku-4-5` | Fast, simple tasks |
| `OPENAI_MODELS.GPT54` | `gpt-5.4` | Complex reasoning |
| `OPENAI_MODELS.GPT5_MINI` | `gpt-5-mini` | Cost-effective tasks |
| `OPENAI_MODELS.GPT41_MINI` | `gpt-4.1-mini` | Moderators, evaluators |
| `OPENAI_MODELS.O3` | `o3` | Reasoning tasks |
| `OPENAI_MODELS.O3_MINI` | `o3-mini` | Fast reasoning |
| `GOOGLE_MODELS.GEMINI_25_PRO` | `gemini-2.5-pro` | Complex tasks |
| `GOOGLE_MODELS.GEMINI_25_FLASH` | `gemini-2.5-flash` | Fast tasks |

### Embedding Models

```typescript
import {
  DEFAULT_EMBEDDING_MODEL,  // 'text-embedding-3-small'
  LARGE_EMBEDDING_MODEL,    // 'text-embedding-3-large'
} from '~/server/utils/models'
```

### Image Models

```typescript
import {
  OPENAI_IMAGE_MODELS,     // GPT_IMAGE_15, DALLE_3 (deprecated)
  GOOGLE_IMAGE_MODELS,     // IMAGEN_4, GEMINI_IMAGE_*
  REPLICATE_IMAGE_MODELS,  // FLUX2_MAX, FLUX2_PRO, NANO_BANANA_2
} from '~/server/utils/models'
```

## Model Tiers

Three tiers for automatic model selection:

| Tier | OpenAI | Anthropic | Google |
|------|--------|-----------|--------|
| `fast` | `gpt-5-mini` | `claude-haiku-4-5` | `gemini-2.5-flash` |
| `capable` | `gpt-5.4` | `claude-sonnet-4-6` | `gemini-2.5-pro` |
| `reasoning` | `o3-mini` | `claude-sonnet-4-6` | `gemini-2.5-pro` |

## Provider Fallback

Fallback order when primary provider fails:

| Preferred | Fallback Order |
|-----------|----------------|
| `openai` | openai → anthropic → google |
| `anthropic` | anthropic → openai → google |
| `google` | google → openai → anthropic |

Explicit model fallback mapping in `FALLBACK_MODEL_MAP`:
- `claude-sonnet-4-6` → `gpt-5.4`
- `gpt-5.4` → `claude-sonnet-4-6`
- `claude-haiku-4-5` → `gpt-5-mini`

## Circuit Breaker

Automatic failure detection prevents cascade failures:

- **Open**: After 3 failures in 60s, circuit opens (fail fast)
- **Half-open**: After 30s cooldown, allows test request
- **Closed**: After 2 consecutive successes, circuit closes

### Health Monitoring

```typescript
import {
  getAllProviderHealth,
  resetCircuit,
  resetAllCircuits,
} from '~/server/utils/ai'

// Check health
const health = getAllProviderHealth()
// [{ provider: 'openai', isHealthy: true, failureCount: 0, ... }]

// Manual reset (admin)
resetCircuit('openai')
```

### Admin Endpoint

`GET /api/admin/ai-health` returns provider health status:

```json
{
  "providers": [
    { "provider": "openai", "isHealthy": true, "configured": true, "failureCount": 0 }
  ],
  "summary": { "healthy": 3, "unhealthy": 0, "unconfigured": 0 }
}
```

## Reasoning Model Handling

`server/utils/ai-helpers.ts` provides `isReasoningModel()` and `buildAIOptions()`:

```ts
// Models detected as reasoning (provider must be 'openai'):
// o1*, o3*, gpt-5* (prefix match)
// Stripped parameters: temperature, frequencyPenalty, presencePenalty, topP
// (both camelCase and snake_case variants)
```

`runtime.ts` additionally strips these for Google/Gemini models (which do not support frequency/presence penalties). For creative-type sparks only, `topP` and `topK` from config are preserved; they are stripped for expert and user spark types.

## Agent Runtime (`server/agents/runtime.ts`)

Central orchestrator for all agentic AI calls. Two main functions:

### `runAgentCompletion(opts)` -- Streaming agentic loop
1. Loads prompt config from local `prompts/*.md` via `getPromptConfig(promptKey)`
2. Normalizes snake_case config to camelCase (`normalizeConfig`)
3. Resolves provider and model, creates provider client
4. Estimates input tokens via `estimateInputTokens()` and warns at 80%/90% context utilization; dynamically reduces `maxSteps` when context is tight
5. Calls `streamText()` with tools, system prompt, messages, and config from Langfuse
6. Processes `fullStream` events: `text-delta`, `tool-call`, `tool-result`
7. Buffers text chunks (50ms / 10-char threshold) for efficient SSE delivery
8. Handles empty-response recovery: if AI used preparatory tools (RAG, web search, image gen) but returned no text, it triggers a follow-up `streamText()` call to force a conversational response
9. Programmatic tool chaining: after `CREATE_FLOW_IDEA`, auto-calls `GENERATE_IMAGE` to visualize new ideas
10. Uses `withRetry()` from `agent-errors.ts` for transient error recovery with exponential backoff
11. Per-tool timeouts via `getToolTimeout()` (e.g., GENERATE_IMAGE: 120s, DOCUMENT_PROCESSING: 90s)
12. Records generation observation to Langfuse with token counts, cost, and `inputTokenEstimate`
13. Records error events via `recordErrorEvent()` for stream errors, tool timeouts, empty responses

### `runModeratorDecision(opts)` -- Structured output
Uses `generateObject()` with `ModeratorDecisionSchema` (Zod) to produce `{ decision: 'CONTINUE'|'STOP', nextSparkId, reasoning }`.

## Streaming Patterns

All chat completions flow through `runAgentCompletion` which uses `streamText()` internally. The `onTextDelta` callback SSE-streams chunks to the client. Key files:
- `server/agents/runtime.ts` -- core streaming via `streamText()`
- `server/utils/voice/orchestrator.ts` -- voice mode: STT -> `streamText()` -> TTS
- `server/api/spark/[id]/greeting.get.ts` -- standalone `streamText()` for spark greetings
- `server/api/flows/[id]/ideas/[ideaId]/messages/index.post.ts` -- idea-specific streaming

## Structured Output (`generateObject`)

Used for AI calls requiring typed JSON responses:

| Location | Schema | Purpose |
|----------|--------|---------|
| `agents/pattern-analyzer.ts` | `{ patterns: [{ aspect, subAspect, spark }] }` | Classify content into aspect/sub-aspect patterns |
| `agents/content-filter.ts` | `{ isRelevant, score, reason, extractedContent }` | Filter content relevance with LLM |
| `agents/runtime.ts` | `ModeratorDecisionSchema` | Flow moderator turn decisions |
| `utils/observability/evaluate.ts` | `EvaluationSchema` | LLM-as-judge scoring (relevance, helpfulness, persona, clarity) |
| `utils/spark-profile.ts` | `SparkProfileSchema` / `KeywordsOnlySchema` | Generate spark profile (name, discipline, keywords) or keywords-only for metadata mode. `SparkTypeSchema` exists but is deprecated (always returns 'expert'). |
| `utils/voice/analyze-personality.ts` | `voicePersonalitySchema` | Determine voice archetype, gender, speed, and cloneability for a spark persona |
| `api/flows/[id]/generate-campaign-brief.post.ts` | Campaign brief schema | Generate campaign briefs |

All use Zod schemas. Pattern: `const { object } = await generateObject({ model, schema, system, prompt })`.

Note: AI SDK v5+ marks `generateObject` as deprecated in favor of `generateText` with `Output.object()`. The codebase still uses `generateObject` -- migration is recommended for new code.

## Tool System

Tools are defined in `server/utils/tools/` using the AI SDK `tool()` function with Zod input schemas:

| Tool | File | Description |
|------|------|-------------|
| `GET_SPARK_RAG` | `tools/rag.ts` | Semantic search over spark's knowledge base (pgvector) |
| `ADD_SPARK_TRAINING_CONTENT` | `tools/rag.ts` | Add content to spark's knowledge base with embedding |
| `WEB_SEARCH` | `tools/web.ts` | Web search via Tavily API with link analysis |
| `ANALYZE_LINK` | `tools/web.ts` | Fetch and analyze a specific URL |
| `CREATE_FLOW_IDEA` | `tools/idea.ts` | Create ideas in flow boards |
| `GENERATE_IMAGE` | `tools/image.ts` | AI image generation (Replicate) |
| `DISPLAY_IMAGE` | `tools/image.ts` | Display images from portfolio |
| `DATABASE_QUERY` | `tools/db.ts` | Query spark's database records |
| `QUERY_CHAT_SESSIONS` | `tools/chat.ts` | Search past chat history |
| `LIST_PORTFOLIO_ITEMS` | `tools/portfolio.ts` | List portfolio items |
| `GET_PORTFOLIO_ITEM_DETAILS` | `tools/portfolio.ts` | Get portfolio item details |
| `FINALIZE_FILE_UPLOAD` | `tools/portfolio.ts` | Complete file upload process |
| `DOCUMENT_PROCESSING` | `tools/file.ts` | Process/analyze uploaded documents |

| `GET_IMAGE_DETAILS` | `tools/image.ts` | Get details of a generated image |
| `EDIT_IDEA` | `tools/idea.ts` | Edit an existing idea |
| `GET_IDEA_COMMENTS` | `tools/idea.ts` | Get comments and edit summaries for an idea |
| `ADD_IDEA_IMAGES` | `tools/idea.ts` | Add images to an idea (array handling, deduplication) |
| `REMOVE_IDEA_IMAGES` | `tools/idea.ts` | Remove images from an idea (exact URL match, cover fallback) |
| `SET_IDEA_COVER` | `tools/idea.ts` | Set idea cover image (cosmetic, no edit history) |
| `ENDORSE_IDEA` | `tools/idea.ts` | Endorse an idea (returns `endorsedBy` with name mappings) |
| `ADD_PORTFOLIO_ITEM` | `tools/portfolio.ts` | Add portfolio item (accepts `sourceUrl`, broad criteria) |

Tools are assembled per-endpoint and passed to `runAgentCompletion({ tools })`. The runtime handles `tool-call` and `tool-result` stream events with per-tool configurable timeouts (default 30s, up to 120s for image generation).

## Prompt Management

**Source of truth**: Local `prompts/*.md` files with YAML frontmatter. Langfuse is synced for observability only.

### Prompt file structure (`prompts/*.md`)
```yaml
---
name: spark-system
config:
  model: claude-sonnet-4-20250514
  provider: anthropic
  temperature: 0.85
  max_tokens: 3000
  maxSteps: 20
labels:
  - production
  - development
---
# Template content with Mustache-style variables
You are {{spark_name}}.
{{#spark_systemPrompt}}{{spark_systemPrompt}}{{/spark_systemPrompt}}
```

### Template syntax (`compilePromptTemplate` in `langfuse-prompts.ts`)
- `{{variable}}` -- simple substitution
- `{{#section}}...{{/section}}` -- conditional (truthy) / array iteration
- `{{^section}}...{{/section}}` -- inverse conditional (falsy/empty)
- `{{.}}` -- current item in array loop
- `{{var|default(fallback)}}` -- default values
- Jinja-style `{% if %}`, `{% for %}` -- legacy support for moderator prompts

### Caching
- 5-minute TTL cache (`MAX_CACHE_SIZE=100`) in production
- Cache disabled in development (`NODE_ENV=development`)
- LRU eviction when cache is full
- Cache key: prompt name + hash of stable variables (isGreetingMode, sparkType, mode, etc.)

### Exported prompt functions
Each prompt type has a dedicated getter in `langfuse-prompts.ts`:
- `getSparkPromptWithMeta(vars)` -- spark-system
- `getFlowPromptWithMeta(vars)` -- flow-context
- `getFlowModeratorPromptWithMeta(vars)` -- flow-moderator-system
- `getTrainerSystemPromptFromLangfuse(vars)` -- trainer-system
- `getIdeaPromptWithMeta(vars)` -- idea-context
- `getGuidedCuratorPromptWithMeta(vars)` -- guided-curator-system
- `getSparkProfilePromptWithMeta(vars)` -- spark-profile-generator
- `getProfileImageGeneratorPromptWithMeta(vars)` -- profile-image-generator-system
- `getEvaluatorPromptFromLangfuse(vars)` -- user-output-evaluator
- `getPromptConfig(promptName)` -- generic: returns raw prompt + config + compile function

## Agent System

All agents in `server/agents/`:

| Agent | Prompt | Function | Description |
|-------|--------|----------|-------------|
| `spark.ts` | `spark-system` | `getSparkSystemPrompt()` | Compiles the full system prompt for a spark. Injects temporal context (date, timezone, knowledge cutoff), spark type booleans, and user language. Records prompt observation to Langfuse. |
| `flow.ts` | `flow-context`, `flow-moderator-system` | `getFlowContextPrompt()`, `getFlowModeratorPrompt()` | Generates flow-scoped context: parses guided context (description/task/method), builds context document summaries, formats existing idea summaries. Moderator prompt takes candidate speaker IDs. |
| `trainer.ts` | `trainer-system` | Uses `generateText` with tools | Training agent with tool access (DB query, chat sessions, web search, portfolio, RAG, training content). Uses `gpt-tokenizer` for token counting. |
| `idea.ts` | `idea-context` | `getIdeaContextPrompt()` | Generates idea refinement context: idea metadata, comment history, original creator, room task. Includes inline fallback if prompt file missing. |
| `evaluator.ts` | `user-output-evaluator` | `evaluateReliability()` | Scores response reliability 0-100 against spark persona. Reads model from prompt config. Returns 70 default for short system prompts, 0 for empty responses. |
| `pattern-analyzer.ts` | `pattern-analyzer-system` | `analyzeContentForPatterns()` | Multi-provider `generateObject` with Zod schema. Classifies content into aspect/sub-aspect patterns. Handles long content via intelligent chunking (1500 chars, 300 overlap). Validates patterns against predefined framework lists. |
| `guidedCurator.ts` | `guided-curator-system` | `generateSparkSuggestions()` | Generates spark team suggestions for guided flows. Uses `runAgentCompletion()`. Parses JSON response, assigns pre-generated portrait images by type/gender/age with uniqueness tracking. |
| `content-filter.ts` | `content-curator-system`, `quick-content-check-system` | `filterContentWithLLM()`, `quickRelevanceCheck()` | LLM-based content relevance filtering. Multi-provider support. Returns relevance score (0-100) with extracted content. Batch filtering in groups of 5 with 1s delay. |
| `runtime.ts` | Any prompt via `promptKey` | `runAgentCompletion()`, `runModeratorDecision()` | Central runtime. See "Agent Runtime" section above. |

## Embedding System

**Model**: `text-embedding-3-large` at 1536 dimensions (OpenAI native client, not AI SDK).

**Chunking**: 1000 chars with 200-char overlap. Word-boundary-aware splitting (breaks at last space if >80% through chunk). Chunks <10 chars are filtered out.

**Deduplication**: SHA-256 content hash per chunk. Skips insertion if `(sparkId, contentHash)` already exists.

**Storage**: `spark_embeddings` table in PostgreSQL with pgvector extension. Raw SQL insert with `::vector` cast.

**Two creation paths**:
1. `server/utils/embeddings.ts` -- `createDirectEmbeddingsFromText()` for direct/manual embedding
2. `server/utils/data-collection/embeddings/generator.ts` -- `createCollectorEmbeddingsFromText()` for data collection pipeline (adds `ON CONFLICT DO NOTHING`)

## RAG Pipeline

`server/utils/tools/rag.ts` provides the complete RAG flow:

1. **Query embedding**: User query is embedded with `text-embedding-3-large` (1536d)
2. **Vector search**: Raw SQL cosine similarity query on `spark_embeddings` via pgvector: `1 - (embedding <=> query_vector::vector)` ordered by similarity DESC
3. **Context formatting**: Chunks formatted as `[#1] content\n\n[#2] content...`
4. **Citation injection**: Tool response includes citation format instructions: `[[RAG:START]]fact[[RAG:END]]`
5. **Access control**: Checks spark ownership, flow membership, or public status

The `GET_SPARK_RAG` tool is available during chat. The `addSparkTrainingContentTool` allows adding new knowledge during training conversations.

## Data Collection Pipeline

`server/utils/data-collection/orchestrator.ts` runs a multi-phase pipeline:

**Phase 1 (Demo/Quick)**: ~0-95% progress
1. Web search via Tavily (up to 300 sources/entity, 5 queries, 10 results each)
2. YouTube transcripts via Apify (primary) / Supadata (fallback), 3 per entity. URL discovery via DuckDuckGo (primary) with Tavily fallback.
3. Content processing with pattern analysis (LLM-based in full mode, heuristic in demo mode)
4. System prompt generation (`generateSystemPromptWithComponents`)
5. Spark description generation (runs in parallel with prompt gen)

**Phase 2 (Full Analysis)**: 96-100%
- Collects additional sources at full limits
- Regenerates system prompt and description with enriched context

**Config** (`data-collection/config.ts`): `COLLECTION_TIMEOUT_MS: 1800000` (30min), `MAX_ENTITIES: 15`, `CHUNK_SIZE: 1000`, `CHUNK_OVERLAP: 200`, `QUALITY_THRESHOLD: 0.7`.

Sub-modules: `search/` (Tavily/YouTube), `filtering/` (LLM content filter), `content/` (extraction), `patterns/` (analysis), `embeddings/` (generator), `spark-generation/` (system prompt, description, profile image).

## Image Generation

`server/utils/image-generation.ts` uses **Replicate API** (not BFL directly):

1. **With face/image references** -> `google/nano-banana-pro` (supports up to 14 reference images, face identity preservation with enhanced prompting)
2. **Text-only** -> `black-forest-labs/flux-kontext-pro` (fast, high quality)
3. **Fallback**: If face refs fail, retries Nano Banana without references

Flow: Create prediction -> Poll every 2s (120s timeout) -> Return image URL. Includes retry logic that removes problematic image URLs on 403/timeout errors.

## Image Analysis

`server/utils/image-analysis.ts` uses `gpt-4o-mini` via AI SDK `generateText()` with vision:

```ts
messages: [{ role: 'user', content: [
  { type: 'text', text: promptText },
  { type: 'image', image: imageUrl }
]}]
```

Used for portfolio image analysis during data collection. Max 500 tokens.

## Observability (Langfuse)

### Initialization (`server/utils/observability/langfuse.ts`)
- OpenTelemetry SDK with `LangfuseSpanProcessor`
- Environment detection: staging/production/development from `SITE_URL`
- `LangfuseClient` for scores and API operations

### Recording (`server/utils/observability/record.ts`)
- `recordGenerationObservation()`: Records model, I/O, token counts (via `gpt-tokenizer`), and cost calculation
- `recordToolObservation()`: Records tool calls as child spans
- `recordErrorEvent()`: Structured error-level events for runtime pipeline issues (stream_error, tool_timeout, empty_response, retry_attempt, recovery_failed)
- `recordDemoEvent()`: Standalone traces for demo funnel tracking (demo.spark.created, demo.conversation.start/turn, demo.signup.clicked, demo.share.clicked, demo.bounce)
- Cost calculation uses `MODEL_PRICING` lookup table (per 1M tokens) with prefix matching. Includes Feb 2026 pricing for `claude-sonnet-4`, `claude-3-5-sonnet`, `o3-mini`, `o4-mini`

### Evaluation (`server/utils/observability/evaluate.ts`)
- `evaluateTrace()`: LLM-as-judge using `gpt-4o-mini` with `EvaluationSchema` (relevance, helpfulness, persona consistency, clarity, overall)
- `queueEvaluation()`: Fire-and-forget background evaluation via `setImmediate`

### Adding tracing to new endpoints
```ts
import { startActiveObservation } from '@langfuse/tracing'
// Inside a traced context (e.g., runAgentCompletion):
await startActiveObservation('prompt:my-prompt', async (obs) => {
  obs.update({ input: vars, output: text, metadata: { promptName, promptLabel } })
})
```

## Environment Variables

| Variable | Required | Purpose |
|----------|----------|---------|
| `OPENAI_API_KEY` | Yes | OpenAI API (LLM + embeddings) |
| `OPENAI_ORG_ID` | No | OpenAI organization ID |
| `OPENAI_API_BASE` | No | Custom OpenAI base URL (proxy) |
| `ANTHROPIC_API_KEY` | No | Anthropic Claude models |
| `GOOGLE_API_KEY` | No | Google Gemini models |
| `REPLICATE_API_TOKEN` | No | Image generation (Replicate) |
| `LANGFUSE_PUBLIC_KEY` | No | Langfuse observability |
| `LANGFUSE_SECRET_KEY` | No | Langfuse observability |
| `LANGFUSE_HOST` | No | Langfuse host (default: cloud.langfuse.com) |
| `TAVILY_API_KEY` | No | Web search in data collection |
| `SERPER_API_KEY` | No | Google Image search |
| `SUPADATA_API_KEY` | No | YouTube transcripts |
| `APIFY_API_TOKEN` | No | Social media profile scraping |
| `BFL_API_KEY` | No | BFL API (legacy, now uses Replicate) |
| `DEBUG_AGENT_RUNTIME` | No | Enable verbose runtime logging |
| `DISABLE_PROMPT_CACHE` | No | Force-disable prompt caching |
| `DEBUG_LANGFUSE` | No | Log suppressed Langfuse errors |

## Safety & Error Handling

### Input Sanitization (`server/utils/safety-filters.ts`)
- `sanitizeInput(text)`: Detects prompt injection patterns, returns `SanitizeResult` with risk level
- `validateOutput(text)`: Redacts tool names and detects leakage patterns in AI output

### Error Classification (`server/utils/agent-errors.ts`)
- `classifyError(error)`: Categorizes errors into `transient` (retryable), `permanent`, or `user_facing`
- `withRetry(fn, opts)`: Exponential backoff retry wrapper for transient errors
- `getToolTimeout(toolName)`: Per-tool timeout configuration (e.g., GENERATE_IMAGE: 120s, DOCUMENT_PROCESSING: 90s, default: 30s)

### Context Management
- `server/utils/context-compression.ts`: Intelligent conversation history compression
  - `scoreMessage()`: Priority-based importance scoring for messages
  - `compressConversationHistory()`: Compression with message promotion and heuristic summaries
  - `compressArtifactList()`: Truncates artifact descriptions for prompt context
  - `buildOptimizedMessages()`: Injects compressed summaries into message array

### Conversation Memory (`server/utils/conversation-memory.ts`)
- `shouldRegenerateSummary()`: Determines when new summaries are needed (15+ messages, then every 10)
- `generateConversationSummary()`: LLM-based rolling summary with heuristic fallback (uses `conversation-summarizer.md` prompt)
- `persistConversationSummary()`: Stores summaries as system FlowMessages with metadata

## Common Pitfalls

1. **Reasoning model parameter errors**: Never pass `temperature`, `frequencyPenalty`, `presencePenalty`, or `topP` to o1/o3/gpt-5 models. Always use `isReasoningModel()` check or `buildAIOptions()`.
2. **Embedding dimension mismatch**: Always use `dimensions: 1536` with `text-embedding-3-large`. The pgvector column and index are configured for 1536.
3. **Provider parameter mismatches**: Gemini does not support `frequencyPenalty`/`presencePenalty` -- `runtime.ts` strips these automatically. Do not add them back.
4. **Prompt config missing model**: If `getPromptConfig()` returns no model, `runtime.ts` throws. Always ensure `config.model` is set in the prompt YAML frontmatter.
5. **Creative-only params**: `topP` and `topK` are stripped for non-creative sparks in `runtime.ts`. If you need them for a new agent type, update the heuristic.
6. **Empty response recovery**: `runtime.ts` handles empty AI responses with follow-up prompts. If adding new preparatory tools, add the tool name to the `preparatoryTools` array.
7. **`generateObject` deprecation**: AI SDK v5+ recommends `generateText` with `Output.object()`. Existing code uses `generateObject` -- prefer `Output.object()` for new code.

## Common Tasks

### Add a new AI-powered endpoint
1. Create route in `server/api/`
2. Create prompt file in `prompts/my-prompt.md` with YAML frontmatter (model, provider, temperature)
3. Load config: `const cfg = await getPromptConfig('my-prompt')`
4. Use `runAgentCompletion()` for tool-enabled streaming, or `generateText()`/`generateObject()` for simple calls
5. Add tracing with `startActiveObservation()`

### Add a new agent
1. Create `server/agents/my-agent.ts`
2. Create `prompts/my-agent-system.md` with config
3. Add variable interface in `langfuse-prompts.ts`
4. Add getter function (e.g., `getMyAgentPromptWithMeta()`)
5. Use `runAgentCompletion()` from `runtime.ts` for execution
6. Record observations with `startActiveObservation()`

### Change a model for an existing agent
1. Edit the `config.model` field in the corresponding `prompts/*.md` file
2. Set `config.provider` if changing providers (openai/anthropic/google)
3. Verify reasoning model compatibility (no temperature params for o1/o3/gpt-5)

## Common Model Tasks

### Update a Model Version

1. Edit constant in `server/utils/models.ts`:
   ```typescript
   SONNET: 'claude-sonnet-4-7',  // Updated from 4-6
   ```

2. Update fallback mappings if needed:
   ```typescript
   FALLBACK_MODEL_MAP.anthropic.models['claude-sonnet-4-7'] = OPENAI_MODELS.GPT54
   ```

3. Update pricing in `server/utils/observability/record.ts`:
   ```typescript
   'claude-sonnet-4-7': { input: 3.00, output: 15.00 },
   ```

### Add a New Model

1. Add constant to appropriate object in `models.ts`:
   ```typescript
   export const OPENAI_MODELS = {
     // ...existing
     GPT6: 'gpt-6',
   }
   ```

2. Add to `FALLBACK_MODEL_MAP` if needed
3. Add to `MODEL_PRICING` for cost tracking
4. Add to `SUPPORTED_MODELS` for API docs

### Add a New Provider

1. Add to `AIProvider` type in `models.ts`
2. Create provider factory in `ai/providers.ts`
3. Add to `API_KEY_ENVS`, `FAST_MODELS`, `CAPABLE_MODELS`, `REASONING_MODELS`
4. Add fallback order in `FALLBACK_ORDER`

## Related Files

### Unified AI Infrastructure
- `server/utils/models.ts` -- Centralized model constants, tiers, fallback mappings
- `server/utils/ai/index.ts` -- Unified executor public API
- `server/utils/ai/executor.ts` -- `executeObject()`, `executeText()`, `generateObjectWithFallback()`
- `server/utils/ai/providers.ts` -- Singleton provider factory
- `server/utils/ai/circuit-breaker.ts` -- Provider health tracking
- `server/utils/ai/types.ts` -- Type definitions
- `server/api/admin/ai-health.get.ts` -- Provider health monitoring endpoint

### Agents & Prompts
- `server/utils/ai-helpers.ts` -- `isReasoningModel()`, `buildAIOptions()`
- `server/utils/embeddings.ts` -- `createDirectEmbeddingsFromText()` (also has private `chunkText()` helper)
- `server/utils/langfuse-prompts.ts` -- All prompt loading, caching, template compilation
- `server/agents/runtime.ts` -- `runAgentCompletion()`, `runModeratorDecision()`
- `server/agents/spark.ts` -- `getSparkSystemPrompt()`
- `server/agents/flow.ts` -- `getFlowContextPrompt()`, `getFlowModeratorPrompt()`
- `server/agents/trainer.ts` -- Training agent with tool access
- `server/agents/idea.ts` -- `getIdeaContextPrompt()`
- `server/agents/evaluator.ts` -- `evaluateReliability()`
- `server/agents/pattern-analyzer.ts` -- `analyzeContentForPatterns()`
- `server/agents/guidedCurator.ts` -- `generateSparkSuggestions()`
- `server/agents/content-filter.ts` -- `filterContentWithLLM()`, `quickRelevanceCheck()`
- `server/utils/tools/` -- All tool definitions (rag, web, image, file, portfolio, db, chat, spark, user)
- `server/utils/data-collection/` -- Full data collection pipeline
- `server/utils/image-generation.ts` -- Replicate image generation (Nano Banana Pro, FLUX Kontext Pro)
- `server/utils/image-analysis.ts` -- Vision model image analysis (gpt-4o-mini)
- `server/utils/spark-profile.ts` -- Spark profile generation with structured output
- `server/utils/observability/langfuse.ts` -- OpenTelemetry + Langfuse initialization
- `server/utils/observability/record.ts` -- Generation/tool observation recording, cost calculation
- `server/utils/observability/evaluate.ts` -- LLM-as-judge evaluation
- `server/utils/voice/orchestrator.ts` -- Voice mode: STT -> streamText -> TTS pipeline
- `server/utils/flow-conversation.ts` -- Flow conversation types and text processing helpers
- `server/utils/safety-filters.ts` -- `sanitizeInput()`, `validateOutput()` for prompt injection and leakage detection
- `server/utils/agent-errors.ts` -- `classifyError()`, `withRetry()`, `getToolTimeout()` error handling
- `server/utils/context-compression.ts` -- Conversation history compression with priority scoring
- `server/utils/conversation-memory.ts` -- LLM-based rolling summaries with DB persistence
- `prompts/*.md` -- All prompt templates with YAML frontmatter configs (includes `conversation-summarizer.md` for rolling summaries)
