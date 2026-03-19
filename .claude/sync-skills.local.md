---
last_sync_commit: 0c62e7d775e9dd02eb045112756cad336fb4ae2e
last_sync_date: 2026-02-20T00:00:00Z
synced_items:
  - voice
  - ai-ml
  - api-server
  - auth
  - database
  - integrations
  - mobile-native
  - real-time
  - state-management
  - ui-components
---
# Sync Notes

Full skill sync against HEAD (0c62e7d), from dbf279ba.

## Changes Made (2026-02-20)

### ai-ml (SKILL.md) — UPDATED
- Added Safety & Error Handling section: sanitizeInput(), validateOutput(), classifyError(), withRetry(), getToolTimeout()
- Added Context Management section: scoreMessage(), compressConversationHistory(), compressArtifactList(), buildOptimizedMessages()
- Added Conversation Memory section: shouldRegenerateSummary(), generateConversationSummary(), persistConversationSummary()
- Updated Agent Runtime: context estimation, dynamic maxSteps, retry integration, inputTokenEstimate, recordErrorEvent
- Added 8 missing tools to Tool System table (GET_IMAGE_DETAILS, EDIT_IDEA, GET_IDEA_COMMENTS, etc.)
- Updated observability: recordErrorEvent(), expanded recordDemoEvent() event types, Feb 2026 MODEL_PRICING
- Added conversation-summarizer.md prompt to Related Files
- Added 4 new utility files to Related Files

### api-server (SKILL.md) — UPDATED
- Added reclone-voices.post cron endpoint (supports sparkIds, includeRetry, dryRun)
- Added chat-rate-limiter.ts utility (sliding-window, per-user/IP, operation-specific limits)
- Added rate limiting details to messages.post and flow messages endpoints
- Added Worker Prisma lazy-loading pattern note
- Added safety-filters.ts, agent-errors.ts, conversation-memory.ts to utilities catalog
- Updated observability entry with recordErrorEvent and recordDemoEvent

### auth (SKILL.md) — UPDATED
- Added iOS Stripe checkout block pitfall (lite/premium blocked, team allowed)
- Added token retrieval triple-fallback documentation
- Added academic enrollment localStorage sync
- Updated create-profile.post.ts description (UTM attribution, welcome email, Google Chat)

### database (SKILL.md) — UPDATED
- Added gotcha #9: Worker lazy-loading pattern for Prisma (DATABASE_URL crash prevention)

### integrations (SKILL.md) — UPDATED
- Updated Google Calendar OAuth: timing-safe state verification, concurrent token refresh dedup, non-blocking webhook failures
- Updated calendar sync: multi-email handling, retry failed attendees, race condition protection
- Updated email template system: escapeHtml(), logEmailEvent(), link validation, spark avatar HTML, public URL conversion
- Added UTM Attribution section (getRawReferrer, first-touch cookie)
- Updated notifyUserSignup with attribution line

### mobile-native (SKILL.md) — UPDATED
- Added iOS Stripe checkout block and Apple subscription routing to RevenueCat section
- Added concurrent purchase guard (isPurchasing ref)
- Added Capacitor plugin proxy .then() interception pitfall
- Added capacitor.config.ts server URL dev-only warning
- Added iOS-only subscription refresh on resume clarification

### voice (SKILL.md) — UPDATED
- Added /api/cron/reclone-voices endpoint to API table and REST endpoints file map
- Added audio-quality-scoring.md to references list
- Updated analyze-personality.ts: isCloneable expanded to fictional characters with iconic voices

### ui-components (SKILL.md) — UPDATED
- Added 5-component MessageInput architecture to input/ directory map
- Added MessageInput system documentation to Form Patterns section
- Updated Input.vue (multiple file support, i18n placeholders)
- Added new AOX icons (chats, mail, minds, publish)

### state-management (SKILL.md) — UPDATED
- Added creationInput to workspace state shape
- Updated startSparkPreview and fetchGreeting signatures (optional creationInput parameter)
- Added race condition guard and resetToIdle clearing of creationInput

### Already in sync (no changes needed)
- real-time — no relevant source file changes
- create-skill — no relevant file changes
- deployment — no relevant file changes
- docs/PRD.md, TASKS.md, docs/design.md — do not exist
