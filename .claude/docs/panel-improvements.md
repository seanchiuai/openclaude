# Panel Feature — Improvement Roadmap

Source: Multi-LLM review (Gemini, Claude Sonnet, Codex) — March 2026

## Quick Wins (very confident)

### 1. Wire up topic clustering for qualitative responses
- `topicClusteringSchema` exists in `panel-response-schemas.ts` but is dead code
- Currently sparks self-label categories, leading to duplicates ("Privacy issues" vs "Privacy concerns")
- Fix: After collecting qualitative responses, run a clustering pass to normalize categories before aggregation
- Files: `server/utils/panel-core.ts` (aggregation section), `server/utils/panel-response-schemas.ts`

### 2. Add concurrency limiter + per-spark timeout
- `Promise.allSettled` fires all sparks at once — 50 sparks = 50 concurrent LLM calls, hits rate limits
- No per-spark timeout — one hanging call blocks the entire panel
- Fix: Add `p-limit(10)` for concurrency, `AbortSignal.timeout(15000)` per spark
- Files: `server/utils/panel-core.ts` (fan-out section)

### 3. Stop rounding scale means to integers
- `Math.round(sum / count)` loses precision (3.2 and 3.8 both become 4)
- Fix: Store unrounded float in `GroupData.value`, let frontend format
- Files: `server/utils/panel-core.ts` (scale aggregation)

### 4. Add classification override
- Question classifier is a single point of failure — misclassification corrupts entire pipeline
- Fix: Add `classificationOverride` field to request body, let user correct before fan-out
- Files: `server/api/panel-stream.post.ts`, `server/api/v1/panels/[panelId]/ask.post.ts`

### 5. Fix misleading MCP tool descriptions
- `askPanel.ts` claims "Qualitative responses are clustered into topics" — they're not
- Fix: Update descriptions to match actual behavior
- Files: `server/mcp/tools/askPanel.ts`

## High Impact

### 6. Add RAG context to panel spark calls
- In regular chat, sparks search their knowledge base (documents, interviews, etc.)
- In panel mode, RAG is skipped — sparks answer purely from system prompt
- A spark trained on 50 customer interviews ignores all that data in panels
- Fix: Query spark's embeddings with the panel question, inject top-k results as context
- Files: `server/utils/panel-core.ts` (prompt building), `server/utils/rag.ts`

### 7. Surface full distributions in real-time results
- Currently: 51% Yes / 49% No shows as just "Yes"
- `panel-statistics.ts` already computes distributions but they're only used in exports
- Fix: Include distribution data in `GroupData` returned to frontend
- Files: `server/utils/panel-core.ts` (aggregation output)

### 8. Add CSV export
- Only PDF/MD narrative exports exist — researchers want raw spreadsheet data
- Fix: Add CSV endpoint with columns: spark, group, question, value, reasoning
- Files: New endpoint or extend `server/api/panel/[flowId]/export.post.ts`

### 9. Fix group filter storage inconsistency
- User message records selected `groupIds`, but assistant result stores ALL groups even when only a subset was queried
- Corrupts later reconstruction, exports, and comparison logic
- Fix: Only store results for the groups actually asked
- Files: `server/api/v1/panels/[panelId]/ask.post.ts`, `server/api/panel-stream.post.ts`

## Strategic

### 10. Snapshot group membership at question time
- Editing a SparkGroup after asking a question silently changes historical results
- Fix: Store a snapshot of group members (spark IDs + names) at question time in message metadata or a dedicated table
- Files: Schema change + `server/utils/panel-core.ts`

### 11. Follow-up and drill-down queries
- No way to ask "why did Group A rate this low?" or filter by previous responses
- Fix: Add `followUpFilter` to message endpoint (e.g. "ask only sparks who rated < 3"), pass previous Q&A as conversation history per spark
- Files: New endpoint + modifications to `server/utils/panel-core.ts`

### 12. First-class response tables (replace JSON blob)
- All spark answers stored as one JSON blob in `FlowMessage.metadata`
- Prevents querying, filtering, cross-panel analysis, longitudinal tracking
- Fix: Create `PanelQuestion`, `PanelResponse`, `PanelGroupResult` tables
- Files: `prisma/schema.prisma`, `server/utils/panel-core.ts`

### 13. Richer SparkGroup metadata
- Groups only have `name + userId` — no description, criteria, segment info
- Fix: Add fields like description, source, criteria, region, lifecycle stage
- Files: `prisma/schema.prisma`

### 14. Cross-panel and longitudinal analysis
- No way to compare same question across panels or track changes over time
- Requires #12 first, plus question fingerprinting for cross-panel matching
- Files: New tables + new API endpoints

## Uncertain (needs validation)

### 15. More "realistic" customer simulation prompts
- Current prompts push direct, confident answers — real customers hedge and hesitate
- Risk: Vague responses may be less useful for extracting insights
- Needs user research to validate

### 16. Per-question-type temperature tuning
- Rating questions → lower temp (more deterministic), open-ended → higher temp (more creative)
- Risk: Effects are subtle, could make results worse. Needs A/B testing

### 17. Full entity redesign
- 8+ new tables to model panels as research platform (runs, snapshots, themes, etc.)
- Risk: Massive migration, high breakage risk. Incremental approach is safer
- Only worth it if panels become core product

### 18. Statistical significance warnings
- With 3-8 AI sparks per group, differences may be noise
- Risk: Could undermine confidence in product. AI personas ≠ real survey respondents

### 19. Question refinement suggestions
- AI reviews question for ambiguity/bias before asking panel
- Risk: Could feel patronizing. Should be optional if implemented
