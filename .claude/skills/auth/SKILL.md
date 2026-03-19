---
name: auth
description: Authentication and authorization using Supabase Auth with PKCE flow. Use when working on login/signup, session management, API key auth, OAuth integration, native app auth (Apple/Google Sign-In), or debugging auth errors. Supports web (cookie), native (Bearer token), API key, and OAuth flows. Do NOT use for general API route creation (use api-server skill) or Stripe billing auth (use integrations skill).
---

# Authentication & Authorization

## Architecture Overview

- **Provider**: Supabase Auth with PKCE flow (`flowType: 'pkce'` in `nuxt.config.ts`)
- **Web auth**: Cookie-based sessions via `@nuxtjs/supabase` (`#supabase/server`)
- **Native auth (iOS)**: Bearer token in `Authorization` header (cookies don't sync in Capacitor WebView)
- **API key auth**: `minds_`-prefixed keys (legacy `aox_` also accepted), PBKDF2-hashed, stored in `ApiKey` table
- **OAuth providers**: Google, Apple (GitHub configured but not exposed in UI)
- **User identity**: Supabase `auth.users` linked to `UserProfile` in Prisma DB

## Auth Flows

### Web (Cookie-Based)
```
Browser -> Supabase JS client (PKCE) -> Cookie set automatically
Server reads cookie via serverSupabaseUser(event) from #supabase/server
```
Supabase config: `redirect: false`, `autoRefreshToken: true`, `persistSession: true`, `detectSessionInUrl: true`.

### Native iOS (Bearer Token)
```
iOS WebView -> auth-fetch.client.ts intercepts $fetch -> adds Authorization: Bearer <access_token>
Production: rewrites /api/* URLs to https://getminds.ai/api/*
Dev: keeps /api/* as-is (local dev server)
```
Plugin `auth-fetch.client.ts` replaces `globalThis.$fetch` on native platforms. Also initializes `_tokenGetter` for `authStreamFetch()` (streaming endpoints).

### Native OAuth (Google/Apple on iOS)
```
iOS -> native SDK (Google One Tap / Apple Sign In) -> gets idToken
     -> supabase.auth.signInWithIdToken({ provider, token })
     -> Supabase session established in WebView
Fallback: web OAuth via signInWithOAuth() if native SDK fails
```
Native Google uses `capacitor-native-google-one-tap-signin`. Native Apple uses `@capacitor-community/apple-sign-in`. Both fall back to web OAuth on non-iOS or on failure.

### Web OAuth (Google/Apple)
```
Browser -> supabase.auth.signInWithOAuth({ provider, redirectTo: /auth/confirm })
        -> Provider login page -> redirect back with ?code=
        -> /auth/confirm exchanges code for session
        -> Creates profile if missing via /api/auth/create-profile
```
For native OAuth initiated via Safari, `?pkce_id=` is present. The confirm page detects this and redirects back to the app via custom URL scheme `com.getminds.app://auth/native-callback?access_token=&refresh_token=`.

### API Key Auth (V1 API only)
```
Client -> Authorization: Bearer minds_<48-hex-chars>
       -> server/middleware/api-auth.ts intercepts /v1/ and /api/v1/ routes
       -> Iterates all ApiKey records, runs verifyKey(storedHash, token)
       -> Updates lastUsedAt timestamp on match
       -> Attaches user to event.context.user
```
Keys are generated as `minds_` + 24 random bytes (hex). Legacy `aox_`-prefixed keys are still accepted. Stored as PBKDF2 hash (`salt:hash` format, 100k iterations, SHA-512). Raw key shown to user only once at creation time. API key creation requires an active subscription (`requireSubscription`).

## Server-Side Auth Functions

### `server/utils/auth.ts`

```ts
// Returns Supabase User or null. Tries: event.context.user cache -> Bearer token -> cookie
getAuthenticatedUser(event: H3Event): Promise<User | null>

// Throws 401 if no user, 404 if no UserProfile. Returns Prisma UserProfile.
requireAuthenticatedUser(event: H3Event): Promise<UserProfile>

// Creates UserProfile if missing. Uses user_metadata for display_name fallback.
ensureUserProfile(user: User): Promise<UserProfile>
```

**Auth resolution order** in `getAuthenticatedUser`:
1. Check `event.context.user` (cached by prior middleware)
2. Parse `Authorization: Bearer <token>` -- skip if `minds_` or `aox_` prefixed
3. Validate token via `serverSupabaseServiceRole(event).auth.getUser(token)`
4. Fall back to `serverSupabaseUser(event)` (cookie-based)

### `server/utils/spark-auth.ts`

```ts
// Pure function - determines access from pre-loaded spark fields
determineSparkAccess(spark: SparkAuthFields, user, sessionId, demoUserId): SparkAccessResult

// DB query - checks ownership, team membership, direct membership
canEditSpark(sparkId, userId, prisma): Promise<boolean>
canViewSpark(sparkId, userId, prisma): Promise<boolean>

// Event handler guards - throw 401/403 on failure
ensureUserCanEditSpark(event, prisma): Promise<void>
ensureUserCanViewSpark(event, prisma): Promise<void>
```

**`SparkAccessResult`** fields: `canEdit`, `canView`, `isOwner`, `isSessionOwner`, `isTeamMember`, `isDirectMember`, `isPublicAccess`, `accessType` (`'owner' | 'collaborator' | 'public' | 'none'`).

**Edit access** = owner OR team member OR direct member (SparkMember). Session owners get edit only if spark is also public.
**View access** = edit access OR `isPublic` OR `profitSplitOptIn` (market) OR demo spark.

### `server/utils/validateOAuthToken.ts`

```ts
// Looks up OAuthAccessToken table, checks expiry. Returns userId or null.
validateOAuthToken(token: string): Promise<string | null>
```

### `server/middleware/api-auth.ts`

Runs on `/v1/` and `/api/v1/` routes. Auth priority:
1. Internal auth (`x-internal-auth: true` + `x-user-id` header, localhost only)
2. Supabase cookie session (`serverSupabaseUser`)
3. API key (`Bearer minds_*` or legacy `Bearer aox_*` -> PBKDF2 verify against all keys, updates `lastUsedAt`)
4. OAuth token (`Bearer <non-minds/aox>` -> `validateOAuthToken`)
5. Throws 401 (except `/v1/api-keys` and `/v1/google-chat` endpoints)

## Route Protection

### `middleware/auth.global.ts`

**Skipped paths**: static assets, `/api/`, `/_nuxt/`, `/mcp`

**Public routes** (no auth required):
`/`, `/auth/login`, `/auth/register`, `/auth/confirm`, `/auth/native-callback`, `/auth/password-reset`, `/legal`, `/guide`, `/research`, `/api`, `/features`, `/industries`, `/keywords`, `/personas`, `/use-cases`, `/workflows`, `/spark/shared/*`, `/flows/shared/*`, `/invite`, `/apply`, `/demo`

**Session wait logic**: On client, if `useSupabaseUser()` is null but `getSession()` returns a session, retries up to 20 times with 100ms delay (`TIMEOUTS.AUTH_RETRY_MAX/DELAY`).

**Post-auth actions** (runs for authenticated users on client):
1. Profile creation: checks `sessionStorage.profile_check_done` to avoid repeated checks, then checks `localStorage.pendingProfileData`, POSTs to `/api/auth/create-profile`
2. Pending invitations: checks `localStorage.pendingInviteToken`, tries accept for flow/spark/team
3. URL token invitations: checks `?token=` query param (skips if `forgotPassword=true`), tries accept for flow/spark/team

**Authenticated user on auth pages**: redirects to `/` unless `?token=` present (invitation flow).

## Auth Pages

| Page | Purpose |
|------|---------|
| `/auth/login` | Redirects to `/?login=true` (login dialog on home page) |
| `/auth/register` | Redirects to `/?register=true` (register dialog on home page) |
| `/auth/confirm` | Handles both OAuth callback (`?code=`) and email confirmation (`?token=&email=&userId=`) |
| `/auth/native-callback` | Receives `access_token` + `refresh_token` from custom URL scheme, calls `supabase.auth.setSession()` |
| `/auth/password-reset` | Redirects to `/?forgotPassword=true&token=&email=&userId=` |

## Signup Flow (Email/Password)

1. Client calls `/api/auth/custom-signup` (bypasses Supabase email batching)
2. Server creates user via `supabaseAdmin.auth.admin.createUser()` with `email_confirm: false`
3. Stores `custom_confirmation_token` (UUID) + expiry (24h) in `user_metadata`
4. Sends confirmation email via Resend with link to `/auth/confirm?token=&email=&userId=`
5. Client stores `pendingProfileData` in localStorage
6. User clicks link -> `/auth/confirm` calls `/api/auth/confirm-email`
7. Server validates token, confirms email via `admin.updateUserById({ email_confirm: true })`
8. Generates magic link session via `admin.generateLink({ type: 'magiclink' })`
9. Client redirects to `sessionUrl` -> auto-login
10. `auth.global.ts` middleware detects `pendingProfileData`, calls `/api/auth/create-profile`

## Password Reset Flow

1. Client calls `/api/auth/reset-password` with email
2. Server paginates through `admin.listUsers()` to find user (no reveal on missing email)
3. Stores `password_reset_token` (UUID) + expiry (1h) in `user_metadata`
4. Sends reset email with link to `/auth/password-reset?token=&email=&userId=`
5. User clicks link -> redirected to `/?forgotPassword=true` with params
6. Client submits new password to `/api/auth/confirm-password-reset`
7. Server validates token, updates password via `admin.updateUserById({ password: newPassword })`

## Client-Side Auth

### `composables/auth/useAuth.ts`

Exposes: `user`, `isAuthenticated`, `isLoading`, `error`, `signUp`, `signIn`, `signInWithGoogle`, `signInWithApple`, `signOut`, `resetPassword`, `confirmPasswordReset`, `updatePassword`, `clearError`.

Platform detection for OAuth: native iOS uses `signInWithIdToken()` (native SDKs), everything else uses `signInWithOAuth()` (web redirect).

### `composables/auth/useTeam.ts`

Global singleton state. Manages team CRUD, invitations, member management. Uses optimistic updates with rollback. Key actions: `loadTeam`, `createTeam`, `inviteMember`, `acceptInvitation`, `removeMember`, `leaveTeam`, `deleteTeam`, `addTeamSeat`.

### `utils/auth-fetch.ts`

Provides `authFetch<T>()` and `authStreamFetch()` for use in Pinia stores and non-component contexts. Automatically adds Bearer token on native platforms. Rewrites API URLs to production domain in native production mode.

## Team Authorization

Team membership is checked in spark access control:
- A spark can have a `teamId` and `isSharedWithTeam` flag
- If both are set, any `TeamMember` of that team gets edit + view access
- Team member check uses `prisma.teamMember.findUnique({ where: { userId_teamId } })`
- Team roles: `admin` and `member` (stored in `TeamMember.role`)
- Team owner is the user who created the team (`Team.ownerId`)

## Common Pitfalls

- **iOS Stripe checkout blocked**: On iOS, Stripe checkout is prevented for `lite` and `premium` plans — these must go through Apple IAP via RevenueCat. Only `team` plans are allowed through Stripe on iOS. See `useSubscription.ts` `subscribe()` early return guard.
- **Token retrieval triple-fallback**: On native, token retrieval in `useSubscription.ts` tries `session.value?.access_token` → `supabase.auth.getSession()` → `supabase.auth.refreshSession()` for maximum resilience. If all fail, the request proceeds without a token.
- **Academic enrollment sync**: After `loadSubscription()`, the server response syncs localStorage — clearing stale `academic_enrolled` flags if the server disagrees with local state.
- **Cookie vs Bearer**: On native apps, cookies don't work. The `auth-fetch.client.ts` plugin must run (`enforce: 'pre'`) to intercept `$fetch`. If auth fails on native, check that the plugin loaded and `session.value?.access_token` is populated.
- **Profile creation timing**: After OAuth signup, the profile may not exist yet. The confirm page and middleware both attempt `create-profile`. Use `ensureUserProfile()` on server if you need a guaranteed profile.
- **Token in getAuthenticatedUser**: Tokens prefixed with `minds_` or `aox_` are explicitly skipped (they're API keys, not Supabase JWTs). Don't pass API keys where Supabase user auth is expected.
- **Session wait on page load**: The middleware waits up to 2s (20 retries x 100ms) for the Supabase user ref to populate. If you see flashing redirects to login, the session may be loading slowly.
- **Custom email flow**: This app does NOT use Supabase's built-in email confirmation. It uses `custom_confirmation_token` in `user_metadata` and sends emails via Resend. Don't use `supabase.auth.signUp()` directly -- use `/api/auth/custom-signup`.
- **Native production URL rewriting**: In production native builds, `/api/*` calls are rewritten to `https://getminds.ai/api/*`. If a new API pattern is added that doesn't start with `/api/`, it won't be intercepted.

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Supabase anonymous/public key (client-safe) |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key (server-only, bypasses RLS) |
| `SITE_URL` | App base URL for email links and OAuth redirects |
| `GOOGLE_CLIENT_ID` | Google OAuth Web Client ID (for native `signInWithIdToken`) |
| `RESEND_API_KEY` | Email service for auth emails (confirmation, password reset, welcome) |

## Related Files

- `server/utils/auth.ts` -- `getAuthenticatedUser`, `requireAuthenticatedUser`, `ensureUserProfile`
- `server/utils/spark-auth.ts` -- `determineSparkAccess`, `canEditSpark`, `canViewSpark`, `ensureUserCanEditSpark`, `ensureUserCanViewSpark`
- `server/utils/validateOAuthToken.ts` -- OAuth access token validation against DB
- `server/utils/crypto.ts` -- `hashKey`, `verifyKey` (PBKDF2 for API keys)
- `server/middleware/api-auth.ts` -- V1 API auth middleware (API key + OAuth token + Supabase session)
- `server/api/auth/custom-signup.post.ts` -- Email/password signup (bypasses Supabase email)
- `server/api/auth/confirm-email.post.ts` -- Custom email confirmation token validation
- `server/api/auth/create-profile.post.ts` -- UserProfile creation + team setup + invitation handling + UTM attribution (via `getRawReferrer()` cookie) + welcome email + Google Chat notification
- `server/api/auth/reset-password.post.ts` -- Password reset token generation + email
- `server/api/auth/confirm-password-reset.post.ts` -- Password reset token validation + update
- `server/api/auth/check-email.post.ts` -- Check if email exists in Supabase
- `server/api/v1/api-keys/index.post.ts` -- API key generation (`minds_` prefix, requires subscription)
- `middleware/auth.global.ts` -- Client route guard, session wait, profile creation, invitation handling
- `plugins/auth-fetch.client.ts` -- Native Bearer token interceptor + URL rewriting
- `plugins/supabase-auth.client.ts` -- OAuth code redirect to /auth/confirm
- `plugins/native-auth.client.ts` -- Native auth plugin loader (minimal, logic in useAuth.ts)
- `composables/auth/useAuth.ts` -- Client auth actions (signUp, signIn, OAuth, password reset)
- `composables/auth/useTeam.ts` -- Team management (CRUD, invitations, optimistic updates)
- `composables/auth/useSubscription.ts` -- Subscription state (used by API key creation guard)
- `utils/auth-fetch.ts` -- `authFetch`, `authStreamFetch` for stores/non-component contexts
- `pages/auth/confirm.vue` -- OAuth callback + email confirmation handler
- `pages/auth/login.vue` -- Redirects to `/?login=true`
- `pages/auth/register.vue` -- Redirects to `/?register=true`
- `pages/auth/native-callback.vue` -- Native OAuth token receiver
- `pages/auth/password-reset.vue` -- Redirects to `/?forgotPassword=true`
- `nuxt.config.ts` (lines 136-164) -- Supabase module config, PKCE flow, redirect options
