---
name: state-management
description: Pinia stores and Vue composables architecture for client-side state management. Use when creating new stores, modifying existing state (auth, sparks, flows, UI), building composables, or debugging reactivity issues. Covers store conventions, composable patterns, persistence, and state hydration. Do NOT use for server-side state or database queries (use database skill).
---

# State Management

Pinia stores (Options API) for global state, composables for reusable multi-store coordination logic. All stores use entity normalization with `Record<string, Entity>` + `ids: string[]` pattern. No `storeToRefs` is used -- components access store properties directly.

## Architecture Overview

```
stores/           -> Global reactive state (8 stores, Options API syntax)
composables/      -> Stateless logic coordinating across stores
WorkspaceContext  -> Vue provide/inject for handler functions in workspace tree
useEventBus       -> Module-level Map-based pub/sub for cross-component events
```

**Data flow**: API (authFetch) -> composable action -> store mutation -> Vue reactivity -> component re-render

## Store Inventory

### useFlowStore (`stores/flow.ts`)
**Domain**: Active flow conversation + flow list for sidebar

**State shape**:
```ts
interface FlowState {
  // Active flow
  flow: FlowEntity | null
  flowSparks: FlowSparkWrapper[]          // { spark: SparkSummary }[]
  guidedSuggestions: GuidedSuggestion[]
  selectedSparkIds: string[]

  // Flow list (normalized entities)
  entities: Record<string, FlowEntity>
  ids: string[]
  selectedId: string | null
  multiSelectedIds: string[]
  isMultiSelectActive: boolean
  isListLoading: boolean
  isCurrentLoading: boolean
  isTransitioning: boolean
  pendingFlowName: string | null
  pendingFlowSparks: FlowSparkWrapper[]
  filterQuery: string
  justCreatedFlowId: string | null        // Prevents watcher from clearing messages
  previewFlow: FlowEntity | null          // Ephemeral preview before first message
  isEnteringPreview: boolean
}
```

**Key getters**: `sparkMap` (Map<id, SparkSummary>), `all` (FlowEntity[]), `getById(id)`, `sidebarFlows` (FlowListItem[] with preview prepended), `flowTitle`, `flowSparkIds` (Set), `hasSelectedFlow`

**Key actions**: `setFlow`, `setFlowSparks`, `mergeSparks`, `setFlows`, `addOptimisticFlow`, `updateOptimisticFlow`, `removeFlows`/`restoreFlows` (optimistic delete), `beginFlowTransition`/`completeFlowTransition`, `setPreviewFlow`/`clearPreviewFlow`/`convertPreviewToOptimistic`, `fetchList`, `deleteFlows`

**Cross-store**: Imports `useLayoutStore` for `resetSparkCreation()` during flow transitions.

### useSparksStore (`stores/sparks.ts`)
**Domain**: Spark (AI agent) entities, selection, filtering, creation tracking

**State shape**:
```ts
interface SparksState {
  entities: Record<string, SparkEntity>
  ids: string[]
  selectedId: string | null
  multiSelectedIds: string[]
  isMultiSelectActive: boolean
  isLoading: boolean
  filterQuery: string
  filterCategory: SparkFilterCategory     // 'all' | 'personal' | 'shared' | 'public'
  creatingSparkIds: string[]              // Multiple concurrent creations
}
```

**Key getters**: `all`, `getById(id)`, `selectedSpark`, `isCreating(spark)` (checks pipelineStatus + local creating list)

**Key actions**: `setSparks`, `upsertSpark`, `removeSparks`/`restoreSparks`, `fetch` (GET /api/spark), `deleteSparks`, `addCreatingSparkId`/`removeCreatingSparkId`/`replaceCreatingSparkId`, `getFiltered(userId, flowSparkIds)` (categorizes into inFlow/personal/shared/public)

### useMessagesStore (`stores/messages.ts`)
**Domain**: Chat message history, streaming state, realtime presence indicators

**State shape**:
```ts
interface MessagesState {
  messages: Message[]
  streamingMessageId: string | null
  isLoading: boolean
  isSending: boolean
  usersTyping: Map<string, { userId; userName; timestamp }>
  sparksThinking: Map<string, { sparkId; sparkName; isThinking; timestamp }>
  sparkToolLabels: Map<string, { sparkId; toolLabelKey; timestamp }>
}
```

**Key getters**: `hasMessages`, `lastMessage`, `isStreaming`, `usersTypingSimple`/`sparksThinkingSimple`/`sparkToolLabelsSimple` (Map<string, string> for components)

**Key actions**: `setMessages`, `clearMessages`, `addUserMessage`, `upsertStreamingMessage`, `appendToMessage`, `startStreaming`/`stopStreaming`, `setUserTyping`/`clearUserTyping`, `setSparkThinking`, `setSparkToolLabel`, `clearRealtimeState`

**Note**: The `useStreamingMessages` composable owns the primary `messages` ref and syncs to this store via watchers. The store serves as a shared read layer for other components.

### useWorkspaceStore (`stores/workspace.ts`)
**Domain**: Workspace mode state machine, preview greeting, spark creation mode

**Modes**: `'idle' | 'flow' | 'preview' | 'sparkCreation'`

**State shape**:
```ts
interface WorkspaceState {
  mode: WorkspaceMode
  activeFlowId: string | null
  activeSparkId: string | null
  previewSpark: PreviewSpark | null
  previewGreeting: string | null
  isLoadingPreviewGreeting: boolean
  isTransitioning: boolean
  creatingSparkId: string | null
  creationInput: string | null            // User's original input that triggered spark creation (passed to greeting for context)
  previewSystemMessages: Array<{...}>     // "Mind joined the chat" messages
}
```

**Key getters**: `isInFlowMode`, `isInPreviewMode`, `isIdle`, `hasActiveContent` (checks layoutStore.sparkCreation.isCollecting too), `previewMessages` (formatted for MessageStream)

**Key actions**: `enterFlowMode(flowId)`, `enterPreviewMode(spark)`, `startSparkPreview(spark, creationInput?)` (enters preview + fetches greeting with optional creation context), `enterSparkCreationMode(sparkId)`, `fetchGreeting(sparkId, creationInput?)` (streams via `streamGreeting` util, includes race condition guard checking `activeSparkId`), `resetToIdle` (also clears `creationInput`), `addPreviewSystemMessage`, `replacePreviewSpark`

**Cross-store**: Imports `useLayoutStore` for `hasActiveContent` getter.

### usePanelsStore (`stores/panels.ts`)
**Domain**: Slide-in panel visibility (left + right panels, mutually exclusive within side)

**State shape**:
```ts
interface PanelsState {
  boardState: SlideInState                // 'folded' | 'unfolded' | 'fullscreen'
  // Left panels (mutually exclusive)
  sparkInfoVisible: boolean; sparkInfoId: string | null; sparkInfoData: SparkInfo | null
  sparkCreationVisible: boolean
  settingsVisible: boolean; settingsPage: string | null
  userAccessVisible: boolean; userAccessMessage: string | null
  slideInMode: 'keep-open' | 'close-sidebar'
  // Right panels
  flowInfoVisible: boolean; flowInfoId: string | null
  ideaInfoVisible: boolean; activeIdea: IdeaInfo | null
  imageInfoVisible: boolean; activeImage: ImageInfo | null
  shareVisible: boolean; activeShareInfo: SharePanelInfo | null
  contentVisible: boolean
}
```

**Key getters**: `hasOpenLeftPanel` (includes userAccessVisible), `hasOpenRightPanel`, `hasAnyPanelOpen`

**Key actions**: `closeLeftPanels`/`closeRightPanels`/`closeAllPanels`, `openSparkInfo(id)`/`openSparkInfoWithData(spark)` (toggle on repeat click), `openSettings(page?)`, `openUserAccess(message?)`, `openFlowInfo`, `openIdeaInfo`, `openImageInfo`, `openShare`, `openContent`

**Cross-store**: Imports `useLayoutStore` to fold sidebar when settings open.

### useLayoutStore (`stores/layout.ts`)
**Domain**: Sidebar state, mobile detection, panel offsets, spark creation progress, input/voice state

**State shape**:
```ts
interface LayoutState {
  sidebarState: 'folded' | 'unfolded'; sidebarWidth: number
  activeNav: 'sparks' | 'flows'
  sidebarOpenedByMention: boolean; mentionFilterQuery: string
  isMobile: boolean; mobileOpenState: 'closed' | 'open'
  mobileDragProgress: number; isMobileDragging: boolean
  leftSlideInWidth: number; rightSlideInWidth: number
  leftSlideInPushing: boolean; rightSlideInPushing: boolean
  voidOverlayLeft: number; voidOverlayRight: number
  sparkCreations: Record<string, SparkCreationState>  // Multiple concurrent
  activeSparkCreationId: string | null
  isInputFocused: boolean; isInputLoading: boolean
  isVoiceModeActive: boolean; voiceModeSparkId: string | null
}
```

**Key getters**: `computedSidebarWidth` (80/380), `computedVoidOverlayLeft`/`Right` (uses panelsStore), `activeSparkCreation`, `sparkCreation` (legacy compat), `mainContentLeftOffset`/`RightOffset`, `mobileMainContentStyle`

**Key actions**: `setSidebarState` (persists to localStorage, delays width change for animation sync), `toggleSidebar`, `openMentionMode`/`closeMentionMode`, `initMobileDetection`/`cleanupMobileDetection`, `startSparkCreation(id)`/`updateSparkCreation(id, data)`/`completeSparkCreation(id)`/`replaceSparkCreationId(tempId, realId)`, `setVoiceModeActive`

**Cross-store**: Imports `usePanelsStore` in getters for overlay calculations, and in `toggleSidebar` action.

### useSettingsStore (`stores/settings.ts`)
**Domain**: Centralized settings data (email/push preferences), loaded once when panel opens

**State shape**: `loading`, `loaded`, `emailPreferences { dailyDigestEnabled }`, `pushPreferences { pushNotificationsEnabled }`

**Key actions**: `loadAll()` (parallel loads subscription, team, profile, email, push prefs), `updateEmailPreferences`, `updatePushPreferences`, `refresh`

**Cross-store**: Dynamically imports composables (`useSubscription`, `useTeam`, `useUserProfile`) to avoid circular deps.

### useTooltipStore (`stores/tooltip.ts`)
**Domain**: Global tooltip position and visibility

**State**: `visible`, `content`, `x`, `y`, `variant` ('compact' | 'large'), `flipX`, `isInfoModeActive`

**Actions**: `show(content, x, y, variant?, flipX?)`, `hide()`, `setInfoMode(active)`

## Composable Architecture

### `composables/flows/` -- Flow Domain Logic
| Composable | Purpose |
|---|---|
| `useFlowManagement` | Flow CRUD, fetch/load flow data, add/remove sparks with optimistic updates |
| `useFlowRealtime` | SSE EventSource connection for live typing, thinking, tool usage, message events |
| `useFlowSparks` | Add/remove sparks from flows with plan limit checks and optimistic system messages |
| `useSparkSync` | Debounced POST to `/api/flows/:id/sparks/sync` to reconcile spark selection |
| `useSparkSuggestions` | Fetch AI-generated spark suggestions for guided flow creation |
| `useMessageHelpers` | DOM ref tracking, markdown rendering, image extraction for messages |
| `useProfileImageQueue` | Queue-based profile image resolution |

### `composables/streams/` -- Streaming
| Composable | Purpose |
|---|---|
| `useStreamingMessages` | Owns the primary `messages` ref. Handles NDJSON streaming (chunk_start/chunk/chunk_end/tool_start/spark_thinking/message/done). Syncs to messagesStore via watchers. |

### `composables/workspace/` -- Workspace Coordination
| Composable | Purpose |
|---|---|
| `useWorkspaceContext` | Vue provide/inject pattern for passing handler functions down the workspace component tree |
| `useWorkspaceReset` | Centralizes all state clearing when clicking "New" (aborts fetches, clears stores, navigates) |
| `useInputSubmit` | Main input handler: routes to send-to-flow, create-flow-from-preview, create-flow-from-mentions, or create-spark. Coordinates 6 stores. |
| `useSparkCreationProgress` | Tracks multiple concurrent spark creations with polling, progress animation, portfolio/pattern fetching |
| `useSlideInCoordination` | Coordinates slide-in panel push/overlay behavior |
| `useSidebarState` | Sidebar open/close state management for workspace |
| `useMultiSelect` | Multi-selection logic for flows/sparks |
| `useFileUpload` | File upload state for workspace input |
| `useSmsIntegration` | SMS/phone integration |

### `composables/core/` -- Shared Utilities
| Composable | Purpose |
|---|---|
| `useEventBus` | Module-level `Map<string, Function[]>` pub/sub. Events: `reset-demo`, `open-register-dialog`, `message-sent`. Auto-unsubscribes on `onUnmounted`. Note: `open-subscription-settings` replaced by `showUpgradePrompt()`. |
| `useSupabase` | Supabase client access |
| `usePlanLimit` | `showPlanLimitAlert()` centralized handler (delegates to `showUpgradePrompt()`) |
| `useUpgradePrompt` | Global reactive `upgradePromptMessage` ref + `showUpgradePrompt(message)` opens settings subscription tab with contextual banner |
| `useUpgradeNudge` | Session-level soft paywall nudges at message milestones (10/30/45) for free users |
| `usePlanFeatures` | Plan feature flags |
| `usePolling` | Generic polling utility |
| `useNative` | Native platform detection |
| `usePushNotifications` | Push notification registration |

### `composables/auth/` -- Authentication
`useAuth` (user state, login/logout), `useSubscription` (plan info), `useTeam` (team management)

### `composables/spark/` -- Spark Streaming
`useGreetingStream` (streams spark greeting), `useSparkProgressStream` (SSE progress during creation)

### `composables/voice/` -- Voice Features
`useVoiceMode` (voice chat orchestration), `useAudioCapture` (microphone access)

### `composables/ui/` -- UI Utilities
`useMobile`, `useMobileSwipe`, `useDynamicColors`, `useTypewriter`, `useScrollBehavior`, `useAnimatedPlaceholder`, `useBoardDragDrop`, `useGlobalTooltip`, `useImageUrl`, `useLanguage`, `useProgressAnimation`, `useSlideInCoordinator`, `useUserProfile`, `useVersion`, `usePlanLimits` (UI layer)

### `composables/analytics/` -- Tracking
`useAnalytics`, `usePostHog`, `useFeatureFlags`, `useTikTokPixel`, `useXPixel`

## Key Patterns

### Entity Normalization
Both `flowStore` and `sparksStore` use the same pattern:
```ts
entities: Record<string, Entity>  // Lookup by ID
ids: string[]                     // Ordered list
// Getter: all = ids.map(id => entities[id]).filter(Boolean)
// Getter: getById = (id) => entities[id]
```

### Optimistic Updates with Rollback
Used in flow/spark deletion and spark add/remove from flows:
```ts
// 1. Save previous state
const removed = this.removeSparks(sparkIds)
try {
  await authFetch('/api/spark', { method: 'DELETE', body: { sparkIds } })
} catch {
  this.restoreSparks(removed)  // Rollback on failure
}
```

### Optimistic Flow Creation
Temporary flows use `temp-` prefix IDs, replaced after API response:
```ts
flowStore.addOptimisticFlow({ id: 'temp-123', name: 'New Chat', sparks })
flowStore.beginFlowTransition('temp-123')
// ... API call ...
flowStore.updateOptimisticFlow('temp-123', realFlow)  // Sets justCreatedFlowId
flowStore.completeFlowTransition()
```

### Preview Flow Lifecycle
Before first message, a preview flow shows a greeting:
```
1. flowStore.setPreviewFlow(spark)         // Creates preview-{sparkId} entry
2. workspaceStore.startSparkPreview(spark)  // Enters preview mode + fetches greeting
3. User sends message ->
4. flowStore.convertPreviewToOptimistic(tempId)  // Returns preview sparks
5. workspaceStore.enterFlowMode(tempId)    // Switches to flow mode
6. API creates real flow -> updateOptimisticFlow
```

### Streaming Message Flow
```
1. useInputSubmit.handleInputSubmit()
2. messagesStore.setSparkThinking(sparkId, true)  // Instant thinking indicator
3. useStreamingMessages.sendMessage() -> authStreamFetch (NDJSON)
4. NDJSON events: spark_thinking -> tool_start -> chunk -> chunk_end -> message -> done
5. Each chunk: appendToMessage() -> messages ref mutated -> watcher syncs to messagesStore
6. On done: streamingMessageId = null, clear sparksThinking
```

### SSE Realtime (Separate from Streaming)
`useFlowRealtime` maintains a persistent EventSource to `/api/flows/:id/stream` for:
- `user_typing` / `new_message` / `assistant_message` (from other users/sessions)
- `spark_chunk_start`/`end`, `spark_tool_start`/`end` (thinking indicators)
- `conversation_done`/`cancelled`, `flow_name_updated`
All realtime state is stored in `messagesStore` Maps (usersTyping, sparksThinking, sparkToolLabels).

### Cross-Component Communication
- **WorkspaceContext**: Vue provide/inject for handler functions (handleSparkSelect, handleInputSubmit, etc). State is NOT passed through context -- components read stores directly.
- **Event Bus**: Module-level Map, used for `open-register-dialog`, `message-sent`, `open-subscription-settings`, `reset-demo`. Auto-cleans listeners on `onUnmounted`.

### Store Access in Components
Components import stores directly (no `storeToRefs`):
```ts
const flowStore = useFlowStore()
const isLoading = computed(() => flowStore.isListLoading)
// Template: flowStore.selectedId, flowStore.flowTitle, etc.
```

## Rules

1. **Stores for global state**: Cached entities, UI state that persists across components, realtime presence
2. **Composables for coordination**: Multi-store logic, API calls with optimistic updates, streaming
3. **No circular store imports**: flow -> layout OK; layout -> panels OK; but panels must NOT import flow
4. **Type all state**: Define interfaces for every store state shape
5. **Actions for mutations**: All state changes through store actions, not direct `store.$patch`
6. **Options API syntax**: All stores use `defineStore('name', { state, getters, actions })` -- NOT setup syntax
7. **Optimistic-first**: Delete/add operations update UI immediately, rollback on API failure
8. **Temp IDs**: Use `temp-` prefix for optimistic flows, `creating-` prefix for sparks being created, `preview-` prefix for preview flows
9. **Dynamic imports in stores**: Use `await import()` for composables/utils inside store actions to avoid circular dependencies (see settingsStore.loadAll)

## Related Files

- `stores/flow.ts` -- Flow entities + active flow state
- `stores/sparks.ts` -- Spark entities + creation tracking
- `stores/messages.ts` -- Messages + streaming + realtime Maps
- `stores/workspace.ts` -- Workspace mode state machine
- `stores/panels.ts` -- Panel visibility management
- `stores/layout.ts` -- Sidebar, mobile, spark creation progress, voice mode
- `stores/settings.ts` -- Email/push preferences
- `stores/tooltip.ts` -- Global tooltip
- `composables/streams/useStreamingMessages.ts` -- NDJSON streaming, primary messages owner
- `composables/flows/useFlowManagement.ts` -- Flow CRUD with abort controller
- `composables/flows/useFlowRealtime.ts` -- SSE EventSource connection
- `composables/flows/useFlowSparks.ts` -- Add/remove sparks with optimistic updates
- `composables/flows/useSparkSync.ts` -- Debounced spark sync
- `composables/workspace/useWorkspaceContext.ts` -- Vue provide/inject context
- `composables/workspace/useWorkspaceReset.ts` -- Centralized state clearing
- `composables/workspace/useInputSubmit.ts` -- Main input routing (6 stores)
- `composables/workspace/useSparkCreationProgress.ts` -- Multi-spark creation polling
- `composables/core/useEventBus.ts` -- Pub/sub event bus
- `composables/core/useUpgradePrompt.ts` -- Upgrade prompt message state + settings panel trigger
- `composables/core/useUpgradeNudge.ts` -- Milestone-based upgrade nudges for free users
- `utils/auth-fetch.ts` -- Authenticated fetch (authFetch, authStreamFetch)
