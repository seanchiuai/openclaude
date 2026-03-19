---
name: real-time
description: Real-time communication via SSE broadcasting, NDJSON streaming, WebSocket voice, and in-memory connection tracking. Use when implementing live updates, streaming responses, real-time progress indicators, WebSocket connections, or debugging streaming issues. Covers SSE event patterns, NDJSON response format, connection lifecycle, and client-side EventSource handling. Do NOT use for background job processing (use processor skill) or voice pipeline specifics (use voice skill).
---

# Real-Time Communication

Three real-time transport mechanisms coexist: SSE for multi-user flow event broadcasting, NDJSON streaming for sender-side AI response delivery, and WebSocket for real-time voice conversations.

## Architecture Overview

```
Sender (POST /api/flows/:id/messages)
  |-> NDJSON stream back to sender (chunk_start, chunk, chunk_end, message, done)
  |-> broadcastMessageToFlow() to OTHER connected users via SSE

Other users (EventSource /api/flows/:id/stream)
  |-> Receive broadcast events (spark_chunk_start, spark_chunk, spark_chunk_end, etc.)

Voice (WebSocket /api/voice/browser-stream or /api/voice/stream)
  |-> Bidirectional audio + transcript messages via crossws
```

**Key distinction**: The message sender receives AI responses via NDJSON on the POST response. Other users on the same flow receive real-time updates via SSE broadcast. These are two separate channels with different event type names.

## Broadcast System (`server/utils/broadcast.ts`)

### Data Structures

```ts
// In-memory connection registry: flowId -> array of H3Event SSE connections
const flowConnections = new Map<string, H3Event[]>()

// Cross-request cancellation flags: flowId -> boolean
const flowCancellations = new Map<string, boolean>()
```

### Exported Functions

| Function | Signature | Purpose |
|---|---|---|
| `addFlowConnection` | `(flowId: string, event: H3Event) => void` | Register SSE connection for a flow |
| `removeFlowConnection` | `(flowId: string, event: H3Event) => void` | Unregister connection; deletes flow key when empty |
| `broadcastMessageToFlow` | `(flowId: string, message: any) => void` | Send SSE event to all connections on a flow |
| `setFlowCancellation` | `(flowId: string) => void` | Set cancellation flag (no boolean param -- always sets true) |
| `isFlowCancelled` | `(flowId: string) => boolean` | Check if cancellation flag is set |
| `clearFlowCancellation` | `(flowId: string) => void` | Delete cancellation flag |

### Broadcast Internals

`broadcastMessageToFlow` formats messages as SSE: `data: ${JSON.stringify(message)}\n\n`

It iterates all connections, writes the formatted message, applies flush strategies, and collects dead connections for cleanup. Dead connections (write throws) are removed in a post-iteration pass.

## SSE Broadcast Event Types

These are the `type` values sent via `broadcastMessageToFlow()` to other connected users:

**Conversation lifecycle**:
- `user_typing` -- typing indicator from a user
- `user_message` -- a user sent a message
- `spark_chunk_start` -- a spark started generating
- `spark_chunk` -- streaming content chunk from a spark (with `chunk` field)
- `spark_chunk_end` -- a spark finished generating
- `spark_tool_start` -- a spark started using a tool (with `toolLabelKey`)
- `spark_tool_end` -- a spark finished using a tool
- `assistant_message` -- complete assistant message
- `conversation_done` -- all sparks finished
- `conversation_cancelled` -- generation was cancelled

**Flow membership**:
- `system` / `system_message` -- system messages (user joined/left)
- `spark_joined` / `spark_left` -- spark added/removed from flow
- `sparks_added` / `sparks_removed` -- batch spark sync events
- `flow_name_updated` -- auto-generated flow name changed

**Ideas & board**:
- `idea_created` -- new idea card created
- `idea_updated` -- idea content/cover changed
- `idea_comment_added` / `idea_comment_deleted` -- idea comments
- `idea_images_updated` / `idea_image_attached` -- idea image changes
- `idea_endorsement_updated` -- endorsement changed
- `idea_feedback_complete` -- concept feedback finished
- `board_position_updated` / `board_connection_added` -- board layout changes

**Keywords**:
- Guided keyword creation broadcasts via `user_message` type (no distinct event type)

## SSE Endpoints

### 1. Flow Stream (authenticated) -- `server/api/flows/[id]/stream.get.ts`
- Verifies user auth and flow access (owner, team member, or direct member)
- Sends 2KB padding comment to bypass proxy buffering thresholds
- Sends `{ type: 'connected', flowId }` immediately
- Heartbeat every 30 seconds (`: heartbeat\n\n`)
- TCP: `setNoDelay(true)`, `setKeepAlive(true, 30000)`
- Uses `flushHeaders()` before any writes
- Returns `new Promise(() => {})` to keep connection open indefinitely

### 2. Shared Flow Stream (public) -- `server/api/flows/shared/[shareId]/stream.get.ts`
- No auth required; validates `publicShareId` + `isLinkSharingEnabled || isPublic`
- Registers with same `addFlowConnection(flowId, event)` as authenticated endpoint
- Heartbeat every 20 seconds
- Listens on both `close` and `end` events for cleanup

### 3. Spark Progress Stream -- `server/api/spark/progress/[sparkId]/stream.get.ts`
- Uses H3's `createEventStream(event)` (the modern H3 SSE API)
- Subscribes to `progressEventBus` (in-memory pub/sub in `server/utils/progress-event-bus.ts`)
- Named events: `connected`, `progress`, `heartbeat`
- Heartbeat every 15 seconds (first at 5 seconds)
- Auto-handles cleanup via `eventStream.onClosed()`
- Returns `eventStream.send()` (H3 manages the connection lifecycle)

### 4. Survey Stream -- `server/api/survey-stream.post.ts`
- POST endpoint that streams SSE (`text/event-stream`)
- Sends `start`, then `answer` per spark, then `done`
- Uses `res.write()` / `res.end()` (manual SSE, no broadcast system)

## NDJSON Streaming (Sender's Response)

When a user sends a message via `POST /api/flows/:id/messages`, the response is `application/x-ndjson`. Each line is a JSON object with a `type` field:

**NDJSON event types** (sender-only, distinct from SSE broadcast types):
- `meta` -- target spark IDs
- `stream_init` -- padding to prime proxy streaming (512 bytes)
- `chunk_start` -- spark info (sparkId, sparkName, sparkType, sparkProfileImageUrl)
- `chunk` -- content chunk (`{ sparkId, chunk }`)
- `tool_start` / `tool_end` -- tool usage indicators
- `spark_thinking` -- spark started thinking (earliest signal)
- `idea_created` -- real-time idea creation
- `chunk_end` -- spark finished
- `message` -- complete persisted message with final metadata
- `error` -- error during generation
- `done` -- stream complete, includes all messages
- `heartbeat` -- keep-alive (every 15 seconds)

## Client-Side Consumption

### `useStreamingMessages` (composable)
- **Purpose**: Handles NDJSON streaming for the message sender
- Consumes `POST` response via `ReadableStream` reader
- Tracks streaming messages per spark via `sparkStreamingIds: Map<sparkId, streamId>`
- Creates placeholder messages on `spark_thinking` (earliest signal for UI)
- Transitions from `isLearning: true` to content on first `chunk`
- On `message` event: updates ID and metadata but keeps `domId` stable (prevents Vue re-mount)
- Clears `streamingChunks` on finalize so markdown rendering takes over
- Uses `AbortController` for cancellation

### `useFlowRealtime` (composable)
- **Purpose**: Manages SSE connection for receiving OTHER users' broadcasts
- Creates `EventSource` to `/api/flows/${flowId}/stream`
- Skips connection for `temp-` flow IDs (optimistic/unsaved flows)
- Handles all broadcast event types and updates `messagesStore`
- Skips `assistant_message` events while sender is streaming (avoids duplicates)
- Auto-reconnect on error after 5 seconds (fixed delay)
- Preserves thinking state across reconnections via `preserveThinking` flag
- Cleans up on `onBeforeUnmount`

### `useSparkProgressStream` (composable)
- **Purpose**: SSE client for spark pipeline progress updates
- Connects to `/api/spark/progress/${sparkId}/stream`
- Exponential backoff reconnection (1s base, max 5 attempts)
- Auto-disconnects when progress reaches `completed` or `failed`

## Cross-Request Cancellation

Flow: User clicks cancel -> `POST /api/flows/:id/cancel` -> `setFlowCancellation(flowId)` + broadcasts `conversation_cancelled`

In the generation loop (`messages/index.post.ts`), checked at two points:
1. Before each spark turn: `if (abortSignal.aborted || isFlowCancelled(flowId))`
2. After each spark turn completes

Cleared at the start of new conversations via `clearFlowCancellation(flowId)`.

## TCP Flush Strategies

Five methods applied in `broadcastMessageToFlow` for low-latency delivery through DigitalOcean App Platform proxies:

1. `socket.setNoDelay(true)` -- Disable Nagle's algorithm (no TCP coalescing)
2. `socket.resume()` -- Resume paused sockets (backpressure recovery)
3. `res.flush()` -- HTTP-level response flush
4. `socket.flush()` -- TCP-level socket flush
5. `socket.emit('drain')` -- Force drain event to trigger write queue flush

The SSE endpoint also sends a 2KB padding comment on connection to exceed proxy buffering thresholds.

## WebSocket Endpoints (Voice)

Nitro config: `experimental: { websocket: true }` enables `crossws` WebSocket support.

### Browser Voice -- `server/routes/api/voice/browser-stream.ts`
- Route: `wss://domain/api/voice/browser-stream`
- Uses `defineWebSocketHandler` from crossws (`Peer`, `Message` types)
- Audio format: PCM16 24kHz mono, base64-encoded
- Protocol: `session.start` (with JWT token + sparkId) -> `session.ready` -> bidirectional `audio`
- Client messages: `session.start` (with JWT token, sparkId, locale), `audio`, `interrupt`, `mute`, `ping`, `end`
- Server messages: `session.ready`, `audio`, `transcript.user`, `utterance.user` (complete user utterance), `transcript.ai`, `ai.speaking`, `ai.done`, `pong`, `error`
- Limits 1 active session per user (`userActiveSessions` map)
- Creates voice session via `server/utils/voice/orchestrator.ts` (Deepgram STT -> LLM -> Fish Audio TTS)

### Twilio Voice -- `server/routes/api/voice/stream.ts`
- Route: `wss://domain/api/voice/stream`
- Bridges Twilio Media Streams with same orchestrator pipeline
- Audio conversion: mu-law 8kHz (Twilio) <-> PCM 24kHz (pipeline)
- Twilio events: `connected`, `start`, `media`, `stop`, `mark`
- Supports `locale` custom parameter for multi-language voice responses

### Client (`composables/voice/useVoiceMode.ts`)
- Connects WebSocket to `/api/voice/browser-stream`
- Sends auth token via `session.start` message (not headers)
- Uses `useAudioCapture` composable for mic input
- Pipes PCM audio chunks as base64 over WebSocket

## Nuxt/Nitro Configuration

```ts
// nuxt.config.ts -> nitro
experimental: { websocket: true }  // Enable crossws WebSocket support

routeRules: {
  '/api/flows/*/messages': {
    headers: { 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' }
  },
  '/api/flows/*/stream': {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Content-Encoding': 'none',
    }
  },
  '/api/public/flow-messages': {
    headers: { 'X-Accel-Buffering': 'no', 'Cache-Control': 'no-cache, no-transform' }
  },
  '/mcp': {
    headers: { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'X-Accel-Buffering': 'no' },
    cors: true
  }
}
```

Additionally, each streaming endpoint sets headers programmatically (belt-and-suspenders approach).

## Common Pitfalls

- **Proxy buffering**: DigitalOcean / nginx buffer responses by default. Must set `X-Accel-Buffering: no`, `Content-Encoding: none`, and send 2KB initial padding.
- **Connection limits**: Browsers limit ~6 concurrent connections per origin. Each open flow SSE stream counts.
- **Memory leaks**: Dead connections must be cleaned up. `broadcastMessageToFlow` handles this via try/catch on write. SSE endpoints must clear heartbeat intervals on disconnect.
- **Dual-channel dedup**: The sender receives data via NDJSON; SSE broadcast is for OTHER users. `useFlowRealtime` skips `assistant_message` while `isCurrentlyStreaming` to avoid duplicates.
- **Temp flow IDs**: `useFlowRealtime` skips SSE connection for `temp-*` IDs. Ensure SSE connects after flow is persisted.
- **In-memory state**: Both `flowConnections` and `flowCancellations` maps are per-process. Not shared across multiple server instances. `progressEventBus` has the same limitation.
- **Never-resolving promise**: The authenticated flow SSE endpoint returns `new Promise(() => {})` to keep the connection open. The shared flow endpoint relies on the event listeners to keep it open without a never-resolving promise. The spark progress endpoint uses `createEventStream` which handles this automatically.
- **WebSocket auth**: Voice WebSocket validates JWT via Supabase in the `session.start` message (not HTTP headers), since browser WebSocket API does not support custom headers.

## Related Files

- `server/utils/broadcast.ts` -- Core broadcast system (connection tracking + cancellation)
- `server/utils/progress-event-bus.ts` -- In-memory pub/sub for spark progress events
- `server/utils/voice/orchestrator.ts` -- Voice session pipeline (STT -> LLM -> TTS)
- `server/utils/voice/deepgram-stt.ts` -- Deepgram speech-to-text integration
- `server/api/flows/[id]/stream.get.ts` -- Authenticated flow SSE endpoint
- `server/api/flows/shared/[shareId]/stream.get.ts` -- Public flow SSE endpoint
- `server/api/spark/progress/[sparkId]/stream.get.ts` -- Spark progress SSE endpoint
- `server/api/survey-stream.post.ts` -- Survey multi-spark SSE endpoint
- `server/api/flows/[id]/messages/index.post.ts` -- NDJSON streaming message endpoint
- `server/api/flows/[id]/cancel.post.ts` -- Cancellation endpoint
- `server/api/flows/[id]/typing.post.ts` -- Typing indicator broadcast
- `server/routes/api/voice/browser-stream.ts` -- Browser voice WebSocket handler
- `server/routes/api/voice/stream.ts` -- Twilio voice WebSocket handler
- `composables/streams/useStreamingMessages.ts` -- Client NDJSON stream consumer
- `composables/flows/useFlowRealtime.ts` -- Client SSE connection manager
- `composables/spark/useSparkProgressStream.ts` -- Client spark progress SSE consumer
- `composables/voice/useVoiceMode.ts` -- Client voice WebSocket manager
- `stores/messages.ts` -- Pinia store for message + realtime state
