---
name: mobile-native
description: Capacitor v7 iOS/Android native app development. Use when working on native mobile features, Apple/Google Sign-In, push notifications (FCM), haptics, deep linking, safe area handling, Xcode Cloud builds, or platform-conditional code. Covers Capacitor plugin patterns, native bridge communication, and App Store submission. Do NOT use for web-only features or server-side changes.
---

# Mobile & Native

Capacitor v7 bridge wrapping the Nuxt 3 web app as a native iOS/Android app. Bundle ID: `com.getminds.app`. Production API: `https://getminds.ai`.

## Capacitor Configuration

`capacitor.config.ts` defines the bridge setup:

```ts
{ appId: 'com.getminds.app', appName: 'Minds AI', webDir: '.output/public', bundledWebRuntime: false,
  ios: { scheme: 'App' },
  plugins: {
    SplashScreen: { launchShowDuration: 2000, backgroundColor: '#000000', showSpinner: false },
    PushNotifications: { presentationOptions: ['badge', 'sound', 'alert'] }
  }
}
```

- `webDir: '.output/public'` -- output of `nuxt generate` (static SSG build)
- iOS scheme `App` means the WebView loads from `capacitor://localhost`
- In dev mode, the WebView connects to `http://localhost:3000` instead

## Platform Detection -- Three Composables

### `usePlatform()` (preferred for components)
Singleton-cached computed refs. Use in components and templates.
```ts
const { isNative, isIOS, isAndroid, isWeb, platform } = usePlatform()
// All are computed refs: isNative.value, isIOS.value, etc.
```

### `useNative()` (for native API access)
Returns plain booleans (not refs) plus haptics, status bar, and safe area APIs.
```ts
const { isNative, isIOS, isAndroid, vibrate, vibrateSuccess, setDarkStatusBar, safeAreaInsets, initNative } = useNative()
// isNative is a plain boolean (Capacitor.isNativePlatform())
```

### `useWebViewDetection()` (for OAuth warnings)
Detects problematic in-app browsers (Instagram, Facebook, LinkedIn, etc.) that break OAuth. Capacitor native apps return `false` since they use the system browser for OAuth.
```ts
const { isInWebView, getBrowserName, getWebViewWarningMessage } = useWebViewDetection()
```

### `useMobile()` (responsive breakpoint only)
Pure CSS breakpoint detection (`window.innerWidth < 768`). Not related to native -- works on web too.
```ts
const { isMobile, MOBILE_BREAKPOINT } = useMobile() // MOBILE_BREAKPOINT = 768
```

## Plugin Inventory

| Plugin | Version | Purpose | Used In |
|--------|---------|---------|---------|
| `@capacitor/core` | ^7.4.4 | Core bridge, `Capacitor.isNativePlatform()` | Everywhere |
| `@capacitor/ios` | ^7.4.4 | iOS runtime | Native build |
| `@capacitor/android` | ^7.4.4 | Android runtime | Native build |
| `@capacitor/cli` | ^7.4.4 | CLI tooling (`cap sync`, `cap open`) | Build scripts |
| `@capacitor/app` | ^7.1.0 | App lifecycle, deep links, back button | `plugins/capacitor-app.client.ts` |
| `@capacitor/push-notifications` | ^7.0.0 | Push registration and handling | `plugins/push-notifications.client.ts`, `composables/core/usePushNotifications.ts` |
| `@capacitor/haptics` | ^7.0.2 | Haptic feedback (impact, notification, selection) | `composables/core/useNative.ts` |
| `@capacitor/status-bar` | ^7.0.3 | Status bar style and color | `composables/core/useNative.ts`, `plugins/capacitor-app.client.ts` |
| `@capacitor/splash-screen` | ^7.0.4 | Launch splash screen (2s, black) | `capacitor.config.ts` |
| `@capacitor/preferences` | ^7.0.3 | Native key-value storage for auth sessions | `utils/capacitor-storage.ts`, `plugins/supabase-storage.client.ts` |
| `@capacitor/camera` | ^7.0.3 | Photo capture/library access | `components/common/ChatInput.vue` |
| `@capacitor/browser` | ^7.0.3 | System browser for OAuth flows | Referenced for OAuth |
| `@capacitor/keyboard` | ^7.0.4 | Keyboard visibility and events | Native build |
| `@capacitor-community/apple-sign-in` | ^7.1.0 | Native Apple Sign-In | `composables/auth/useAuth.ts` |
| `capacitor-native-google-one-tap-signin` | ^7.0.3 | Native Google One Tap Sign-In | `composables/auth/useAuth.ts` |
| `@revenuecat/purchases-capacitor` | ^11.3.2 | In-app purchases (iOS IAP, subscription management) | `composables/iap/useRevenueCat.ts`, `plugins/capacitor-app.client.ts` |

Additionally, iOS uses **Firebase/Core** and **Firebase/Messaging** CocoaPods for FCM token handling (see `ios/App/Podfile`).

## Native Auth Flow

Native apps cannot use cookie-based auth (WebView cookies do not sync with the server). Instead, all API requests use Bearer token auth.

### Sign-In Flow (iOS)

1. **Google**: `useAuth().signInWithGoogle()` detects `isNative && platform === 'ios'`, calls `signInWithGoogleNative()` which uses `capacitor-native-google-one-tap-signin`. The ID token is exchanged with Supabase via `signInWithIdToken()`. Falls back to web OAuth if native fails.
2. **Apple**: `useAuth().signInWithApple()` on iOS calls `signInWithAppleNative()` using `@capacitor-community/apple-sign-in`. ID token exchanged with Supabase.
3. **Web OAuth fallback**: For Android or when native sign-in fails, opens system browser with `supabase.auth.signInWithOAuth()`. The callback at `/auth/confirm` detects `pkce_id` query param (native OAuth indicator), exchanges code, then redirects back to the app via custom URL scheme `com.getminds.app://auth/native-callback?access_token=...&refresh_token=...`.
4. **Native callback**: `/pages/auth/native-callback.vue` receives tokens from URL, calls `supabase.auth.setSession()` to establish the WebView session.

### Session Persistence

`plugins/supabase-storage.client.ts` uses `@capacitor/preferences` to persist Supabase sessions across app restarts. On auth state changes, the session is written to native storage under key `sb-session`. On app launch, stored sessions are restored via `supabase.auth.setSession()`.

### API Request Interception

`plugins/auth-fetch.client.ts` (runs with `enforce: 'pre'`) intercepts all `$fetch` calls on native:
- Adds `Authorization: Bearer <token>` header to `/api/*` requests
- In production, rewrites `/api/*` URLs to `https://getminds.ai/api/*` (since the app loads from `capacitor://localhost`)
- In dev mode, URLs stay relative (local dev server)

For streaming requests, use `authStreamFetch()` from `utils/auth-fetch.ts` which applies the same token injection and URL rewriting to native `fetch()` calls.

### CORS for Native

`server/middleware/cors-native.global.ts` allows `capacitor://` and `ionic://` origins on `/api/` routes, including preflight `OPTIONS` handling.

## Push Notifications

### Registration Flow

1. `plugins/push-notifications.client.ts` runs on native app startup, sets up listeners
2. On `registration` event, POSTs token to `/api/notifications/register` with platform
3. Token stored in `DeviceToken` Prisma model (`device_tokens` table): `{ id, userId, token (unique), platform ('ios'|'android'), createdAt, updatedAt }`
4. `registrationError` listener logs failures

### iOS Native Setup

`ios/App/App/AppDelegate.swift` configures Firebase, sets `Messaging.messaging().delegate`, and bridges APNS tokens to FCM tokens. FCM token is posted to Capacitor via `NotificationCenter` using `.capacitorDidRegisterForRemoteNotifications`.

### Notification Handling

- **Foreground**: `pushNotificationReceived` listener logs; iOS shows banner/badge/sound via `UNUserNotificationCenterDelegate`
- **Tap action**: `pushNotificationActionPerformed` reads `notification.data` and navigates: `sparkId` -> `/?sparkId=X`, `flowId` -> `/flows/X`, `daily_digest` -> `/`

### Permission Management

`composables/core/usePushNotifications.ts` provides `checkPermission()`, `requestPermission()`, `unregister()`, `registerIfPermitted()`. Used in `components/settings/general.vue` for the notification toggle.

## In-App Purchases -- RevenueCat

iOS subscription management via RevenueCat (`@revenuecat/purchases-capacitor`).

### Initialization
- `plugins/capacitor-app.client.ts` initializes RevenueCat on iOS when a user is authenticated
- Watches Supabase user state; on login, calls `useRevenueCat().initialize(userId)` to configure RevenueCat with the user's ID
- On app resume (`appStateChange` -> `isActive`), refreshes subscription state via `useSubscription().loadSubscription(true)` to pick up purchases made in the App Store purchase sheet

### Composable (`composables/iap/useRevenueCat.ts`)
- `initialize(userId)` -- Configures RevenueCat SDK with user ID via async `loadPurchasesModule()` (lazy Capacitor plugin loading)
- Manages subscription offerings and purchase flow for iOS native subscriptions
- Concurrent purchase guard: `isPurchasing` ref prevents double-purchase calls with logging
- Used alongside Stripe (web) for unified billing -- RevenueCat handles mobile IAP, Stripe handles web
- **iOS-only Stripe block**: `useSubscription.subscribe()` throws error on iOS for `lite`/`premium` plans (only `team` plans allowed through Stripe on iOS)
- **Manage subscription routing**: On iOS, always opens `https://apps.apple.com/account/subscriptions` directly (never Stripe portal)

### CocoaPods
- `RevenuecatPurchasesCapacitor` pod in `ios/App/Podfile`

## App Lifecycle

All handled in `plugins/capacitor-app.client.ts`:

- **CSS classes**: Adds `native-app` and `platform-{ios|android}` to `<html>` for CSS targeting
- **iOS viewport**: Sets `maximum-scale=1, user-scalable=no, viewport-fit=cover` to prevent zoom on input focus
- **Deep links**: `appUrlOpen` listener parses custom scheme URLs (`com.getminds.app://path`) and navigates via Nuxt router
- **Status bar**: Syncs with `useColorMode()` -- dark mode gets `Style.Light` (white icons), light mode gets `Style.Dark` (black icons). Android also sets background color.
- **RevenueCat init** (iOS): Watches for authenticated user and initializes RevenueCat SDK with user ID
- **App state**: `appStateChange` listener fires on foreground/background transitions. On iOS resume, refreshes subscription state via `loadSubscription(true)`.
- **Back button** (Android): Uses history back if possible, otherwise `App.minimizeApp()`

## Deep Linking & URL Schemes

- **Custom URL scheme**: `com.getminds.app://` configured in `Info.plist` via `CFBundleURLTypes` (auto-patched by `scripts/capacitor-post-sync.mjs`)
- **Universal Links**: `App.entitlements` declares `applinks:getminds.ai`, `applinks:www.getminds.ai`, `applinks:staging.getminds.ai`
- **Web credentials**: `webcredentials:getminds.ai` and `webcredentials:staging.getminds.ai` for password autofill association
- **OAuth redirect**: After web OAuth completes in Safari, `/auth/confirm` redirects back via `com.getminds.app://auth/native-callback?access_token=...&refresh_token=...`

## Swipe Gestures

`composables/ui/useMobileSwipe.ts` -- call once in the main layout. Attaches document-level touch listeners.

- **Open sidebar**: Swipe right from left edge (< 30px from left)
- **Close sidebar**: Swipe left when sidebar is open
- **Drag-to-follow**: Updates `layoutStore.mobileDragProgress` (0-1) for smooth animation
- **Configurable**: `edgeThreshold` (default 30px), `swipeThreshold` (default 80px)
- Distinguishes horizontal vs vertical swipes; aborts on vertical scroll

## Haptic Feedback

Provided by `useNative()` from `composables/core/useNative.ts`. All methods are no-ops on web.

| Method | Capacitor API | Use Case |
|--------|---------------|----------|
| `vibrate(style?)` | `Haptics.impact({ style })` | Default: `ImpactStyle.Light` |
| `vibrateSuccess()` | `Haptics.notification({ type: Success })` | Positive actions |
| `vibrateWarning()` | `Haptics.notification({ type: Warning })` | Caution states |
| `vibrateError()` | `Haptics.notification({ type: Error })` | Error states |
| `vibrateSelection()` | `Haptics.selectionStart/End` | Selection changes |

## Safe Area Handling

### CSS Variables (in `assets/css/main.css`)
```css
:root {
  --sat: env(safe-area-inset-top, 0px);
  --sab: env(safe-area-inset-bottom, 0px);
  --sal: env(safe-area-inset-left, 0px);
  --sar: env(safe-area-inset-right, 0px);
}
```

### Utility Classes
- `.safe-area-top`, `.safe-area-bottom`, `.safe-area-left`, `.safe-area-right`, `.safe-area-all` -- apply corresponding `env(safe-area-inset-*)` padding
- `.keyboard-safe` -- bottom padding for inputs near keyboard
- `.native-viewport` -- full viewport container (`100dvh`, `100%` in native)

### Native-Specific CSS (scoped to `html.native-app`)
- Prevents overscroll bounce (`overscroll-behavior: none`)
- Disables text size adjustment (`-webkit-text-size-adjust: 100%`)
- Forces 16px font on inputs (prevents iOS zoom)
- 44px minimum touch targets on mobile (Apple HIG)
- Hides scrollbars on mobile
- Disables `backdrop-filter` (causes WKWebView rendering issues)
- `.haptic-feedback:active` adds subtle scale-down effect
- Removes tap highlight (`-webkit-tap-highlight-color: transparent`)

## Build & Deploy

### NPM Scripts
| Script | Action |
|--------|--------|
| `mobile:build` | `nuxt generate && npx cap sync && node scripts/capacitor-post-sync.mjs` |
| `mobile:ios` | Full build + open Xcode |
| `mobile:sync` | Sync only (no web build) |
| `build:mobile` | `nuxt generate` with Prisma generate (no engine) |
| `ios:build` | `build:mobile` + `CAPACITOR_BUILD=production cap sync ios` |
| `ios:beta` | Build + Fastlane beta (TestFlight, skip processing wait) |
| `ios:release` | Build + Fastlane release (TestFlight + git version bump) |

### Post-Sync Script
`scripts/capacitor-post-sync.mjs` patches `Info.plist` and `AndroidManifest.xml` to add the `com.getminds.app` custom URL scheme for deep linking. Runs automatically after `cap sync`.

### Fastlane (iOS)
`ios/App/fastlane/Fastfile` defines two lanes:
- **beta**: Increment build number, build with `app-store` export, upload to TestFlight
- **release**: Same as beta + `ensure_git_status_clean`, commit version bump, push to git

API key loaded from `APP_STORE_KEY_ID`, `APP_STORE_ISSUER_ID`, and either `APP_STORE_KEY_CONTENT` (CI) or `AuthKey.p8` file (local).

### Xcode Cloud
`ios/App/ci_scripts/ci_post_clone.sh` handles CI builds: installs Node 22 via nvm, creates `.env` from Xcode Cloud env vars, runs `npm ci`, generates Prisma client (no engine), `nuxt generate`, `cap sync ios`, and `pod install`.

## Native Project Structure

### iOS (`ios/App/`)
- `App/AppDelegate.swift` -- Firebase init, push notification bridging (APNS -> FCM), URL handling
- `App/Info.plist` -- Bundle config, URL schemes, camera/photo permissions, orientations
- `App/App.entitlements` -- Push notifications (`aps-environment`), Sign in with Apple, associated domains (universal links)
- `App/GoogleService-Info.plist` -- Firebase config for FCM
- `Podfile` -- All Capacitor pods + Firebase/Core + Firebase/Messaging. Min iOS 14.0.
- `fastlane/` -- Appfile (team ID `5Q7VWK48G5`) + Fastfile

### Android
No `android/` directory currently exists in the repository. Android support is configured in package.json scripts but the native project has not been initialized.

## Platform-Conditional Patterns

```ts
// In components -- use usePlatform() (computed refs for reactivity)
const { isNative } = usePlatform()
// In templates: v-if="isNative"

// In plugins/utils -- use Capacitor directly (outside component context)
if (Capacitor.isNativePlatform()) { ... }

// CSS targeting
html.native-app .my-element { /* native-only styles */ }
html.platform-ios .my-element { /* iOS-only styles */ }

// Detecting native via DOM (for utilities outside Vue context)
document.documentElement.classList.contains('native-app')

// Native image URLs need token appended (useImageUrl composable)
const { normalizeImageUrl } = useImageUrl()
// Appends ?token=<access_token> and prepends API_BASE_URL in production native
```

## Common Pitfalls

- **Cookie auth does not work on native** -- all API calls must use Bearer tokens. The `auth-fetch.client.ts` plugin handles this automatically for `$fetch`, but manual `fetch()` calls must use `authStreamFetch()`.
- **Production URL rewriting** -- native apps load from `capacitor://localhost`, so `/api/*` calls need rewriting to `https://getminds.ai/api/*`. This is automatic via the auth-fetch plugin, but any new fetch patterns must account for it.
- **Plugin not available errors** -- always dynamically import Capacitor plugins (`await import('@capacitor/push-notifications')`) and guard with `Capacitor.isNativePlatform()` to prevent web crashes.
- **Safe area insets** -- always apply `safe-area-top`/`safe-area-bottom` on fixed headers/footers in native. The viewport meta tag includes `viewport-fit=cover`.
- **Input zoom on iOS** -- inputs must be at least 16px font size. The native CSS forces `font-size: 16px !important` on all inputs.
- **Backdrop blur** -- `backdrop-filter` is disabled on native (`html.native-app`) due to WKWebView rendering bugs. Use solid background colors instead.
- **Session persistence** -- Supabase sessions are stored in `@capacitor/preferences` (native key-value store), not `localStorage`. The `supabase-storage.client.ts` plugin handles this.
- **PostHog disabled on native** -- analytics are disabled when `currentProtocol === 'capacitor:'` or `currentHost === 'localhost'` to avoid noise from dev/native builds.
- **OAuth flow for native** -- goes through system Safari, not the WebView. Tokens must be passed back via custom URL scheme redirect. The `pkce_id` query parameter identifies native OAuth callbacks on `/auth/confirm`.
- **Capacitor plugin proxy `.then()` interception** -- Capacitor plugin proxies intercept `.then()`. Never return a Capacitor plugin object from an async function (causes "Purchases.then() is not implemented on ios"). Always extract the result before returning.
- **`capacitor.config.ts` server URL** -- The `server.url` field is a local-only dev setting (points to staging/prod for testing). Do not commit without asking -- it must be removed or reset for production builds.
- **iOS subscription refresh on resume** -- Only fires on iOS (`platform === 'ios'`), not Android. Refreshes subscription state when app returns to foreground to catch App Store purchase sheet completions.

## Environment Configuration

- `GOOGLE_CLIENT_ID` -- required for native Google One Tap sign-in (set as runtime config `googleClientId`)
- `CAPACITOR_BUILD=production` -- set during `ios:build` to signal production native build
- Xcode Cloud env vars: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SITE_URL`, plus optional analytics/payment keys
- `GoogleService-Info.plist` in iOS project for Firebase/FCM configuration

## Related Files

- `capacitor.config.ts` -- Capacitor bridge configuration
- `plugins/auth-fetch.client.ts` -- Bearer token interceptor and URL rewriting for native
- `plugins/supabase-storage.client.ts` -- Session persistence via Capacitor Preferences
- `plugins/push-notifications.client.ts` -- Push notification registration and handling
- `plugins/capacitor-app.client.ts` -- App lifecycle, deep links, status bar, back button
- `plugins/native-auth.client.ts` -- Native auth plugin loader
- `utils/auth-fetch.ts` -- `authFetch()` and `authStreamFetch()` for native API calls
- `utils/capacitor-storage.ts` -- Storage adapter (Preferences on native, localStorage on web)
- `composables/core/useNative.ts` -- Haptics, status bar, safe area, platform booleans
- `composables/usePlatform.ts` -- Singleton cached platform detection (computed refs)
- `composables/core/usePushNotifications.ts` -- Push permission/registration composable
- `composables/ui/useWebViewDetection.ts` -- In-app browser detection for OAuth warnings
- `composables/ui/useMobile.ts` -- Responsive breakpoint detection (768px)
- `composables/ui/useMobileSwipe.ts` -- Swipe gesture handling for sidebar
- `composables/ui/useImageUrl.ts` -- Image URL normalization with native token injection
- `composables/useAuthFetch.ts` -- Component-scoped auth fetch wrapper
- `composables/auth/useAuth.ts` -- Auth methods including native Google/Apple sign-in
- `composables/iap/useRevenueCat.ts` -- RevenueCat IAP initialization and purchase flow
- `server/middleware/cors-native.global.ts` -- CORS headers for native origins
- `middleware/auth.global.ts` -- Auth middleware (includes `/auth/native-callback` as public route)
- `pages/auth/confirm.vue` -- OAuth callback with native app redirect
- `pages/auth/native-callback.vue` -- Receives tokens from Safari and establishes WebView session
- `scripts/capacitor-post-sync.mjs` -- Patches Info.plist/AndroidManifest for URL schemes
- `assets/css/main.css` -- Safe area utilities and `html.native-app` scoped styles
- `ios/App/App/AppDelegate.swift` -- Firebase, push notification bridging, URL handling
- `ios/App/App/Info.plist` -- Bundle config, permissions, URL schemes
- `ios/App/App/App.entitlements` -- Push, Apple Sign-In, universal links
- `ios/App/Podfile` -- CocoaPods dependencies
- `ios/App/fastlane/Fastfile` -- TestFlight beta/release lanes
- `ios/App/ci_scripts/ci_post_clone.sh` -- Xcode Cloud build script
