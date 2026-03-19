---
name: integrations
description: Third-party service integrations including Stripe billing, Google Calendar, Twilio (SMS/WhatsApp/Voice), Resend email, Firebase push notifications, analytics (PostHog/GA/TikTok), Langfuse observability, content scraping (Apify/Tavily/Serper), and image generation (Replicate). Use when adding a new third-party integration, modifying billing logic, working with webhooks, configuring analytics tracking, or debugging external API calls. Do NOT use for AI/LLM provider integration (use ai-ml skill) or voice pipeline specifics (use voice skill).
---

# External Integrations

## Payment -- Stripe

Three subscription tiers: `free`, `lite`, `premium`, plus `academic` (code-based) and `team` (per-seat). Defined in `utils/plans.ts` as `PlanTier`.

### Plan Limits (`PLAN_LIMITS`)
| Tier | Projects | Sparks | Messages | Sparks/Flow |
|------|----------|--------|----------|-------------|
| free | 1 | 2 | 50 | 1 |
| lite | 5 | 5 | 500 | 3 |
| premium | 999 | 999 | 999999 | 7 |
| academic | 999 | 999 | 999999 | 7 |
| team | 999 | 999 | 999999 | 7 |

### Checkout Flow
- `server/api/billing/checkout.post.ts` -- Creates `stripe.checkout.sessions.create()` in `subscription` mode
- Finds/creates Stripe customer by email, resolves currency from existing subscriptions or geo-IP (`server/utils/geo.ts`)
- Premium plan gets 14-day free trial (`trial_period_days: 14`)
- Team plan: checks for existing team subscription, updates quantity if active, cancels personal premium/lite before creating team checkout
- Promotion codes enabled, automatic tax, tax ID collection, billing address required

### Subscription Resolution
- `server/utils/stripe.ts` -- `resolveUserPlan()` checks in order: team membership -> academic enrollment -> Stripe subscriptions
- Searches across all Stripe customers matching user email, inspects all subscription items against configured product IDs
- Returns `{ plan, subscriptionId, isTeamPlan, teamId, isTrialing, trialEndsAt }`

### Webhook Events Handled (`server/api/billing/webhook.post.ts`)
| Event | Action |
|-------|--------|
| `checkout.session.completed` | Creates team record via `createOrUpdateTeamWithSubscription()`, sends Google Chat purchase notification via `notifyPurchase()` |
| `customer.subscription.updated` | Updates team `maxMembers`, expires pending invitations on seat reduction |
| `customer.subscription.deleted` | Downgrades team to `free`, clears Stripe IDs |
| `customer.subscription.trial_will_end` | Logs trial ending (email notification TODO) |

### Other Billing Endpoints
- `portal.post.ts` -- Creates `stripe.billingPortal.sessions.create()`, team members restricted to owner only
- `subscription.get.ts` -- Returns plan, products, prices for all tiers (premium, lite, team) sorted by preferred currency
- `session.get.ts` -- Retrieves checkout session status after redirect
- `academic.post.ts` -- Validates access code (`ACADEMIC_ACCESS_CODE` env var), sets `academicEnrolled` in `UserPreferences`

### Key Utility: `server/utils/stripe.ts`
```ts
getStripeClient(event)       // new Stripe(sk, { apiVersion: '2024-06-20' })
getPremiumProductId(event)   // config.stripePremiumPid
getLiteProductId(event)      // config.stripeLitePid
getTeamProductId(event)      // config.stripeTeamPid
resolveUserPlan(event)       // Full plan resolution logic
```

## Calendar -- Google Calendar

Full OAuth 2.0 integration with real-time webhook sync. On connect, fetches future events and auto-creates spark profiles for attendees.

### OAuth Flow (`server/utils/google-calendar-oauth.ts`)
1. **Authorize**: `GET /api/integrations/google-calendar/authorize` -- Generates signed state (HMAC-SHA256, 10min expiry), redirects to Google consent with scopes `calendar.readonly` + `calendar.events`, `access_type: 'offline'`, `prompt: 'consent'`
2. **Callback**: `GET /api/integrations/google-calendar/callback` -- Verifies state with timing-safe comparison (`timingSafeEqual`), exchanges code for tokens via `https://oauth2.googleapis.com/token`, stores in `GoogleOAuthToken` model. Webhook setup failures are non-blocking (user gets success redirect with `calendar_warning=webhook_failed` param)
3. **Token Refresh**: `getValidAccessToken()` auto-refreshes if token expires within 5 minutes; deduplicates concurrent refresh requests via `inflightRefreshes` Map (prevents race conditions). Deletes token on refresh failure
4. **Disconnect**: Revokes token with Google, deletes `CalendarWebhookChannel` records and `GoogleOAuthToken`

### Webhook System (`server/utils/google-calendar-webhook.ts`)
- `createCalendarWatch()` -- Registers `web_hook` channel via Google Calendar API, 7-day TTL
- Webhook URL: `/api/webhooks/google-calendar`
- `renewExpiringChannels()` -- Cron job renews channels expiring within 2 days
- Webhook handler checks `x-goog-channel-id`, `x-goog-resource-state`, `x-goog-resource-id` headers

### Event Sync (`server/utils/google-calendar-sync.ts`)
- On webhook `exists` notification: fetches future events, processes attendees
- Creates `SyncedCalendarEvent` records, hashes attendees for change detection
- Collects all user email addresses from `GoogleOAuthToken` table to avoid processing the user as an attendee (handles multiple Google accounts)
- Retry logic: if attendees haven't changed but some previously failed, retries failed attendees in chunks of 3
- Race condition protection: final duplicate-spark check during `createSparkForAttendee()` prevents concurrent creation
- Enriches attendees via `google-calendar-enrichment.ts`, generates spark profiles

### Prisma Models
- `GoogleOAuthToken` -- userId, accessToken, refreshToken, expiresAt, scope
- `CalendarWebhookChannel` -- userId, channelId, resourceId, expiration, calendarId
- `SyncedCalendarEvent` -- userId, googleEventId, attendees
- `CalendarAttendeeSpark` -- links events to created sparks

## Email -- Resend

All transactional email via Resend SDK (`server/utils/email.ts`). Sender: `Minds AI <hello@getminds.ai>`.

### Email Types
| Function | Trigger |
|----------|---------|
| `sendAuthEmail()` | Signup confirmation, password reset, email change |
| `sendWelcomeEmail()` | Post-signup onboarding |
| `sendTeamInvitationEmail()` | Team invite |
| `sendFlowInvitationEmail()` | Flow/chat invite |
| `sendSparkInvitationEmail()` | Mind collaboration invite |
| `sendDailyDigestEmail()` | Cron-triggered daily digest (`/api/email/digest/cron`) |

### Template System
- `generateGenericEmailHtml()` -- Shared HTML template with logo, CTA button, footer, unsubscribe link
- All emails have both HTML and plain-text variants
- Spam-safe: proper MIME headers, `escapeHtml()` for injection prevention, link validation (rejects unsafe relative URLs), MSO compatibility
- `logEmailEvent()` -- Structured logging for send_start/send_success/send_error events
- Daily digest features spark avatars with type-colored borders (`generateSparkAvatarHtml()`), conversation snippets
- Private image URL conversion: `/api/generated-images/` URLs rewritten to public Supabase storage URLs for email accessibility

## SMS & Voice -- Twilio

Twilio handles SMS inbound/outbound, WhatsApp messaging, voice webhooks, and phone number provisioning (`server/utils/twilio.ts`).

### SMS (`server/api/sms/webhook.post.ts`)
- Inbound webhook receives Twilio form-encoded body (`TwilioSmsWebhook` type)
- Looks up spark by `phoneNumber` field in DB, runs `runAgentCompletion()` with SMS-specific context (320 char limit, no markdown)
- In-memory conversation history per `sparkId:senderNumber` (max 20 messages)
- Responds with TwiML XML: `<Response><Message>...</Message></Response>`
- No tools enabled for SMS (speed optimization)

### WhatsApp (`server/api/whatsapp/webhook.post.ts`)
- Same phone numbers handle both SMS and WhatsApp (distinguished by `whatsapp:` prefix)
- Rich features: typing indicator (`sendWhatsAppTypingIndicator()`), media attachments (images/audio/video/docs), @mention detection
- Media processing: downloads via Twilio auth, uploads to Supabase temp storage, processes via `createDocumentProcessingTool`
- Tools enabled (RAG, web search) via `getToolsForContext({ chatMode: 'whatsapp' })`
- WhatsApp sender registration via `registerWhatsAppSender()` -- syncs spark profile to WhatsApp Business
- Background sync queue: `queueWhatsAppSync()` via BullMQ with 3 retries, exponential backoff

### Phone Number Management
- `searchAvailableNumbers()` -- Searches by country, tries Local/Mobile/TollFree types
- `purchasePhoneNumber()` -- Handles regulatory bundles (`TWILIO_BUNDLE_SID`) for EU countries
- `configureSmsWebhook()` / `configureVoiceWebhook()` -- Sets webhook URLs on purchased numbers
- `releasePhoneNumber()` -- Releases number back to pool
- Geo-IP detection via `ip-api.com` for country-appropriate number provisioning

## Notifications -- Google Chat

Internal team notifications via Google Chat webhooks (`server/utils/google-chat.ts`).

### Functions
| Function | Trigger |
|----------|---------|
| `sendGoogleChatNotification(message, webhookUrl?)` | Generic message to Google Chat webhook |
| `notifyUserSignup(data)` | New user registration (name, email, accountType, provider, UTM source + raw referrer attribution line) |
| `notifyPurchase(data)` | Subscription purchase (email, planName, amount, currency, subscriptionId) |

### Configuration
- `GOOGLE_CHAT_WEBHOOK_URL` -- runtime config `googleChatWebhookUrl`
- Non-blocking: failures are logged but do not interrupt the calling flow

### UTM Attribution (`server/utils/utm-tracking.ts`)
- `getRawReferrer(event)` -- Retrieves raw referrer hostname from first-touch attribution cookie
- Cookie set by `plugins/utm-tracking.client.ts` on initial page load from HTTP Referer header
- Used in `create-profile.post.ts` to attribute signups to referrer source

## Push Notifications -- Firebase

Native push via Firebase Cloud Messaging (`server/utils/push.ts`).

- Firebase Admin SDK initialized lazily with service account credentials
- `sendPushNotification(tokens, { title, body, data, imageUrl })` -- Uses `sendEachForMulticast()`
- Auto-cleans invalid tokens (`messaging/invalid-registration-token`, `messaging/registration-token-not-registered`) from `DeviceToken` table
- Client plugin (`plugins/push-notifications.client.ts`) -- Capacitor-only, registers token via `/api/notifications/register`, handles foreground notifications and tap actions (navigates to sparkId/flowId)

## Analytics & Tracking

### PostHog (`plugins/posthog.client.ts`)
- Product analytics with session replay (always on)
- Disabled in dev/staging/Capacitor localhost
- Cookie consent: uses `localStorage+cookie` with consent, `memory` (cookieless) without
- Auto-captures: click, submit, change DOM events + SPA navigation via `capture_pageview: 'history_change'`
- Auto-identifies users via Supabase auth watcher
- Provides: `capture()`, `identify()`, `reset()`, `getFeatureFlag()`, `isFeatureEnabled()`, `onFeatureFlags()`
- API host: `https://eu.i.posthog.com` (EU data residency)

### Google Analytics (`plugins/google-analytics.client.ts`)
- GA4 via gtag.js, consent-first (default all denied)
- `consent` update on cookie-consent-updated event: `analytics_storage`, `ad_storage`, `ad_user_data`, `ad_personalization`
- Sends page_view after consent granted

### TikTok Pixel (`plugins/tiktok-pixel.client.ts`)
- Marketing pixel, loads only with `marketing` consent
- `holdConsent()` / `grantConsent()` / `revokeConsent()` flow
- Tracks page views via `ttq.page()`

## LLM Observability -- Langfuse + OpenTelemetry

### Initialization (`server/utils/observability/langfuse.ts`)
- `NodeSDK` with `LangfuseSpanProcessor` for distributed tracing
- `LangfuseClient` for API operations (scores)
- Environment detection: checks `SITE_URL` for staging/localhost, falls back to `NODE_ENV`

### Prompt Management (`server/utils/langfuse-prompts.ts`)
- Fetches prompts from Langfuse API with TTL cache (`MAX_CACHE_SIZE` to prevent memory bloat)
- Local fallback: `.md` files with YAML frontmatter parsed via custom parser
- `getSparkPromptWithMeta()` -- Returns compiled prompt text + metadata for trace linking
- Template variables: `spark_systemPrompt`, `spark_name`, `spark_type`, `userName`, `userLanguage`, temporal context

### Generation Recording (`server/utils/observability/record.ts`)
- `recordGenerationObservation()` -- Records model, input/output, token counts (via `gpt-tokenizer`), cost calculation
- `MODEL_PRICING` map with per-1M-token pricing for GPT-5.x, GPT-4.1, GPT-4o, Claude Sonnet 4, o-series
- `recordToolObservation()` -- Records tool calls as child spans
- `recordDemoEvent()` -- Standalone traces for demo funnel events (spark created, conversation start/turn, signup clicked, etc.)

### LLM-as-Judge Evaluation (`server/utils/observability/evaluate.ts`)
- `evaluateTrace()` -- Uses `gpt-4o-mini` with `generateObject()` to score: relevance, helpfulness, personaConsistency, clarity, overall (0-1)
- `queueEvaluation()` -- Fire-and-forget background evaluation via `setImmediate`

## Content Processing -- Scraping & Search

### Apify (`server/utils/social-scraper.ts`)
- Social media profile scraping: Instagram, Twitter/X, LinkedIn, TikTok, YouTube, Facebook, GitHub
- `SOCIAL_PLATFORMS` also recognizes URLs for Threads, Reddit, Snapchat, Pinterest, Behance (URL detection only; scraping returns null for unsupported platforms)
- `isScrapableProfileUrl()` distinguishes profile pages from post/content pages (e.g., LinkedIn `/in/` vs `/posts/`)
- Uses platform-specific Apify actors (actor IDs converted via `toApifyActorPath()`)
- Returns `SocialProfileData`: username, fullName, bio, followers, posts, profilePictureUrl, company
- Default avatar detection for LinkedIn, Instagram, Twitter
- `persistProfilePicture()` downloads and stores social profile pictures permanently via Supabase Storage

### Tavily (`server/utils/tools/web.ts`, `server/utils/data-collection/search/tavily.ts`)
- Web search tool: `createWebSearchTool()` -- `search_depth: 'basic'`, 3 results, includes images
- Used in data collection pipeline with configurable limits (`TAVILY_QUERY_LIMIT: 5`, `TAVILY_RESULTS_PER_QUERY: 10`)
- Citation format: `[[WEB:START:domain.com]]fact[[WEB:END]]`

### Serper (`server/utils/tools/image.ts`)
- Google Images API via `https://google.serper.dev/images`
- `searchWebImages()` -- Falls back to Tavily image results if Serper unavailable
- Filters hotlink-blocked domains (ResearchGate, Academia)

### YouTube Transcripts (Supadata)
- `SUPADATA_API_KEY` for YouTube video transcription
- Used in data collection pipeline alongside Apify YouTube scraper

## Image Generation -- Replicate

`server/utils/image-generation.ts` -- Unified interface with automatic model selection:

| Input Type | Model | Use Case |
|-----------|-------|----------|
| Face references or input images | `google/nano-banana-pro` via Replicate | Face-preserving generation, compositing (up to 14 images) |
| Text only | `black-forest-labs/flux-kontext-pro` via Replicate | Fast text-to-image |

### Flow
1. `generateImage()` selects model based on inputs
2. Face references pre-processed via `prepareFaceReferenceImages()` (re-uploads to Supabase for accessibility)
3. Creates prediction via Replicate API, polls every 2s (max 2min)
4. Retry logic: on image-related errors (403, timeout), removes problematic URL and retries
5. Fallback: if face refs fail, tries Nano Banana without references
6. `downloadAndStoreGeneratedImage()` stores result permanently via `image-storage.ts`

### Image Storage
- `server/utils/image-storage.ts` -- Downloads generated images and stores in Supabase Storage
- Profile images served via `/api/generated-images/` route

## Environment Variables

### Required
| Variable | Service |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI (LLM, evaluation) |
| `STRIPE_PK`, `STRIPE_SK` | Stripe (client/server keys) |
| `STRIPE_PREMIUM_PID` | Stripe premium product ID |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | Supabase |
| `DATABASE_URL`, `DIRECT_URL` | PostgreSQL (via Supabase) |

### Billing
| Variable | Purpose |
|----------|---------|
| `STRIPE_LITE_PID` | Lite tier product ID |
| `STRIPE_TEAM_PID` | Team tier product ID |
| `STRIPE_WEBHOOK_SECRET` | Webhook signature verification |
| `ACADEMIC_ACCESS_CODE` | Academic plan activation code |

### Communication
| Variable | Purpose |
|----------|---------|
| `RESEND_API_KEY` | Email sending |
| `SENDER_EMAIL` | From address (default: `hello@getminds.ai`) |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | SMS/WhatsApp/Voice |
| `TWILIO_BUNDLE_SID`, `TWILIO_ADDRESS_SID` | EU regulatory compliance |
| `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` | Push notifications |

### Calendar
| Variable | Purpose |
|----------|---------|
| `GOOGLE_CALENDAR_CLIENT_ID` | OAuth client ID |
| `GOOGLE_CALENDAR_CLIENT_SECRET` | OAuth client secret |

### Content & Search
| Variable | Purpose |
|----------|---------|
| `TAVILY_API_KEY` | Web search |
| `SERPER_API_KEY` | Google Image search |
| `APIFY_API_TOKEN` | Social media scraping |
| `SUPADATA_API_KEY` | YouTube transcripts |
| `REPLICATE_API_TOKEN` | Image generation (Replicate) |
| `BFL_API_KEY` | Black Forest Labs (legacy) |
| `ELEVENLABS_API_KEY` | Text-to-speech |

### Analytics & Observability
| Variable | Purpose |
|----------|---------|
| `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` | LLM observability |
| `LANGFUSE_HOST` | Langfuse endpoint (default: `https://cloud.langfuse.com`) |
| `NUXT_PUBLIC_POSTHOG_API_KEY`, `NUXT_PUBLIC_POSTHOG_API_HOST` | PostHog analytics |
| `NUXT_PUBLIC_GTAG_ID` | Google Analytics 4 |
| `NUXT_PUBLIC_TIKTOK_PIXEL_ID` | TikTok Pixel |

### Notifications
| Variable | Purpose |
|----------|---------|
| `GOOGLE_CHAT_WEBHOOK_URL` | Google Chat webhook for internal team notifications |

### Infrastructure
| Variable | Purpose |
|----------|---------|
| `CRON_SECRET` | Cron job authentication |
| `CONVOY_PROXY_URL`, `CONVOY_SECRET` | A/B testing proxy |

## Adding a New Integration

1. Install SDK: `npm install <package>`
2. Create server utility in `server/utils/<service>.ts` with config validation (`process.env.X || null` pattern)
3. Add API routes in `server/api/` (follow existing webhook/REST patterns)
4. Add env vars to `.env.example` with documentation comments
5. Register env vars in `nuxt.config.ts` under `runtimeConfig` (server) or `runtimeConfig.public` (client)
6. **Update subprocessors**: Edit both `content/legal/en/subprocessors.md` and `content/legal/de/subprocessors.md`
7. If using caching, follow TTL pattern from `server/utils/langfuse-prompts.ts` with `MAX_CACHE_SIZE`

## Related Files

- `server/api/billing/` -- Stripe checkout, portal, webhook, subscription endpoints
- `server/utils/stripe.ts` -- Stripe client, product IDs, plan resolution
- `utils/plans.ts` -- Plan tier definitions and limits
- `composables/core/usePlanLimit.ts` -- Client-side plan limit enforcement
- `server/api/integrations/google-calendar/` -- OAuth authorize, callback, disconnect, status
- `server/utils/google-calendar-oauth.ts` -- Token management, refresh, revocation
- `server/utils/google-calendar-webhook.ts` -- Webhook channel lifecycle
- `server/utils/google-calendar-sync.ts` -- Event sync and attendee spark creation
- `server/utils/google-calendar-enrichment.ts` -- Attendee data enrichment
- `server/utils/email.ts` -- All Resend email templates and send functions
- `server/api/email/digest/cron.post.ts` -- Daily digest cron job
- `server/utils/twilio.ts` -- SMS, WhatsApp, voice, phone number management
- `server/api/sms/webhook.post.ts` -- Inbound SMS handler
- `server/api/whatsapp/webhook.post.ts` -- Inbound WhatsApp handler
- `server/utils/push.ts` -- Firebase Admin push notifications
- `plugins/push-notifications.client.ts` -- Capacitor push registration
- `plugins/posthog.client.ts` -- PostHog analytics + session replay
- `plugins/google-analytics.client.ts` -- GA4 with consent management
- `plugins/tiktok-pixel.client.ts` -- TikTok marketing pixel
- `server/utils/observability/langfuse.ts` -- Langfuse + OpenTelemetry init
- `server/utils/observability/record.ts` -- Generation/tool observation recording
- `server/utils/observability/evaluate.ts` -- LLM-as-judge evaluation
- `server/utils/langfuse-prompts.ts` -- Prompt fetching with TTL cache + local fallback
- `server/utils/google-chat.ts` -- Google Chat webhook notifications
- `server/utils/social-scraper.ts` -- Apify social media scraping
- `server/utils/tools/web.ts` -- Tavily web search tool
- `server/utils/tools/image.ts` -- Serper image search tool
- `server/utils/image-generation.ts` -- Replicate image generation
- `server/utils/image-storage.ts` -- Supabase image storage
- `server/utils/data-collection/config.ts` -- Data collection pipeline config
- `server/api/webhooks/google-calendar.post.ts` -- Google Calendar push notification handler
- `content/legal/en/subprocessors.md` -- English subprocessor list
- `content/legal/de/subprocessors.md` -- German subprocessor list
- `.env.example` -- All environment variable documentation
