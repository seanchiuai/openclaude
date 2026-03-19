---
task: Implement Web Plugin
issue: 342
branch: issue/342-web-plugin
created: 2026-02-25
status: in_progress
---

# Implement Web Plugin

## Objective
Build a Chrome extension (MV3) with a Vue 3 + Vite + Tailwind side panel that observes pages, suggests relevant Minds, and allows in-context chat. PR #452 has an existing implementation — review, test, and iterate.

## Constraints
- Must share components with existing script tag widget (DRY)
- Chrome extension MV3 format
- Right-side slider UI aligned with existing Art of X design
- Supabase auth (email + Google OAuth)

## Items
- [x] 1. Review PR #452 implementation and verify it builds/loads in Chrome
  - Where: `extension/` directory (check PR diff)
  - Test: Extension loads in Chrome, side panel opens via toolbar icon and Alt+M
- [x] 2. Verify Supabase auth flow (email + Google OAuth) works in extension context
  - Test: Sign in with both methods, verify token refresh
- [x] 3. Test page content extraction and spark relevance ranking
  - Where: Service worker, page metadata extraction
  - Test: Navigate to various pages, confirm extraction and ranking
- [x] 4. Test chat functionality with markdown rendering and conversation persistence
  - Test: Chat with a spark, verify rendering and persistence across navigation
- [x] 5. Test spark creation (manual + AI-generated from page content)
  - Test: Create sparks via both modes, confirm they appear in list
- [x] 6. Verify context compression and conversation memory (15+ messages)
  - Where: Server-side `server/utils/conversation-memory.ts` + agent runtime
  - Test: Send 15+ messages, verify compression and summary generation
- [ ] 7. Run all unit tests (safety-filters, agent-errors, context-compression, conversation-memory)
  - Test: All 30 unit tests pass
  - **STATUS: NO PROJECT-LEVEL TESTS EXIST** — no .test.ts or .spec.ts files outside node_modules
- [x] 8. Test prompt-injection safety filters
  - Where: `server/utils/safety-filters.ts` — integrated into message endpoints
  - Test: Log-only detection with 10+ injection patterns, risk classification

## Done
- [x] Extension core infrastructure (manifest.json MV3, service worker, vite build)
- [x] Side panel UI: AuthView, MainView, ChatView, CreateSparkView, SparkList, SparkAvatar
- [x] Supabase auth with PKCE, Google OAuth via chrome.identity.launchWebAuthFlow
- [x] Page content extraction (OG tags, JSON-LD, social profiles, noise removal)
- [x] Chat with markdown rendering (marked.js + DOMPurify), local persistence
- [x] Spark creation (manual + AI via /api/spark/analyze-page)
- [x] Safety filters (prompt-injection detection, output leakage, risk classification)
- [x] Server endpoints: GET /api/v1/sparks, POST completion, POST analyze-page, POST create-from-input
- [x] Conversation memory & context compression (server/utils/conversation-memory.ts)
- [x] CORS + auth middleware for extension requests
- [x] Spark color alignment with chat-widget.js
- [x] AI slop cleanup
- [x] Shared UI component library (`shared/ui/`) — Phase 1: SparkAvatar, ChatBubble, LoaderDots, markdown, colors, CSS
- [x] Chrome extension wired to shared UI — Phase 2: replaced extension SparkAvatar, ChatView, markdown with shared imports
- [x] Blob URL memory leak fix in shared SparkAvatar
- [x] Security hardening: HTML escaping in markdown code blocks, URL protocol validation

## Findings
- **No unit tests exist** for extension or server code — task 7 cannot pass as-is. Need to create test infrastructure.
- Conversations persist in chrome.storage.local only (no cross-device sync).
- No content script injection — page access is read-only via executeScript.
- SparkList has no pagination (loads all sparks at once).
- Safety filters are log-only (non-blocking) by design.
