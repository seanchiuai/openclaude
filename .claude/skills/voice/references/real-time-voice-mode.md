# Real-Time Voice Mode Reference

Detailed reference for the browser and Twilio WebSocket voice handlers, client composables, and UI components.

## WebSocket Protocol (Browser)

### Client to Server Messages

| type | fields | description |
|------|--------|-------------|
| `session.start` | `sparkId`, `token`, `locale` | Initiate session with Supabase JWT + locale for language |
| `audio` | `data` (base64 PCM16 24kHz) | Microphone audio chunk |
| `interrupt` | -- | Abort current AI response |
| `mute` | `muted` (boolean) | Mute toggle (client-side gating only) |
| `ping` | -- | Keep-alive heartbeat (sent every 30s) |
| `end` | -- | Graceful disconnect |

### Server to Client Messages

| type | fields | description |
|------|--------|-------------|
| `session.ready` | `sparkName`, `voice` | Session initialized successfully |
| `audio` | `data` (base64 PCM16 24kHz) | TTS audio chunk for playback |
| `transcript.user` | `text`, `isFinal` | User speech transcription (interim + final) |
| `transcript.ai` | `text`, `isFinal` | AI response text (streamed chunks, then final) |
| `ai.speaking` | -- | AI started generating response |
| `utterance.user` | `text` | Complete user utterance (after silence gap) |
| `ai.done` | -- | AI finished speaking |
| `pong` | -- | Keep-alive heartbeat response |
| `error` | `message` | Error notification |

## Browser WebSocket Handler (`server/routes/api/voice/browser-stream.ts`)

### Session Management

```ts
// In-memory state
const activeSessions = new Map<string, BrowserSession>()  // peerId → session
const userActiveSessions = new Map<string, string>()       // userId → peerId

interface BrowserSession {
  voiceSession: ReturnType<typeof createVoiceSession> | null
  userId: string | null
  sparkId: string | null
}
```

### Session Start Flow

1. Client sends `session.start` with `sparkId`, `token` (Supabase JWT), and `locale`
2. Server validates JWT via `supabase.auth.getUser(token)`
3. Access check via `canViewSpark(sparkId, userId)` — rejects with 1008 if denied
4. If user already has an active session, the old one is killed (1 session per user)
5. Server looks up spark from DB, including voice fields and `voiceProfile`
6. `getVoiceId(spark)` determines Fish Audio voice (cloned > pool > gender fallback > default)
7. `parseVoiceProfile(spark.voiceProfile)` extracts archetype/speed for prosody
8. `validateAndRecoverVoiceId()` checks pool voice validity via Fish Audio API, selects alternate if invalid
9. System prompt built with locale-aware language enforcement for non-English locales
10. `createVoiceSession()` creates the orchestrator pipeline with prosody overrides
11. Server sends `session.ready` with `sparkName` and `voice`

### Callback Wiring

The `createVoiceSession()` callbacks are wired to send WebSocket messages:

```ts
onAudioOut(pcmBuffer) → sendMessage(peer, { type: 'audio', data: base64 })
onUserTranscript(text, isFinal) → sendMessage(peer, { type: 'transcript.user', text, isFinal })
onUtteranceComplete(text) → sendMessage(peer, { type: 'utterance.user', text })
onAiTranscript(text, isFinal) → sendMessage(peer, { type: 'transcript.ai', text, isFinal })
onAiSpeaking() → sendMessage(peer, { type: 'ai.speaking' })
onAiDone() → sendMessage(peer, { type: 'ai.done' })
onError(err) → sendMessage(peer, { type: 'error', message: err.message })
```

### Cleanup

`cleanupSession(peerId)` is called on `close`, `error`, and `end` message:
- Calls `voiceSession.close()` (stops STT, TTS, and abort controller)
- Removes from `activeSessions` and `userActiveSessions` maps

## Twilio WebSocket Handler (`server/routes/api/voice/stream.ts`)

### Twilio Media Streams Protocol

Twilio uses its own message format with `event` instead of `type`:

| event | description |
|-------|-------------|
| `connected` | WebSocket connected, no-op |
| `start` | Stream started, contains `customParameters` (sparkId, callerNumber) |
| `media` | Audio chunk: `media.payload` is base64 mulaw 8kHz |
| `stop` | Stream stopped, cleanup |
| `mark` | Playback acknowledgment, currently ignored |

### Audio Format Conversion

Twilio sends mulaw 8kHz; the pipeline needs PCM16 24kHz. Conversion via `server/utils/audio-convert.ts`:

```
Twilio → mulawToPcm24k() → orchestrator → pcm24kToMulaw() → Twilio
```

### Sending Audio Back to Twilio

```ts
function sendAudioToTwilio(peer, streamSid, audioBase64) {
  peer.send(JSON.stringify({
    event: 'media',
    streamSid,
    media: { payload: audioBase64 }  // base64 mulaw
  }))
}
```

### Twilio Webhook (`server/api/voice/webhook.post.ts`)

Handles incoming phone calls. Returns TwiML that:
1. Plays `<Say voice="Polly.Joanna">Connecting you to {sparkName}.</Say>`
2. Connects to `<Stream url="wss://{host}/api/voice/stream">` with sparkId and callerNumber parameters

**Localhost fallback**: If `SITE_URL` contains "localhost", rewrites to `staging.getminds.ai` since Twilio can't reach localhost.

## Voice Orchestrator (`server/utils/voice/orchestrator.ts`)

Central pipeline manager shared by both browser and Twilio handlers.

### Interface

```ts
interface VoiceSessionConfig {
  sparkId: string
  sparkName: string
  systemPrompt: string
  voiceId: string
  prosody?: { speed: number }
  onAudioOut: (pcmBuffer: Buffer) => void
  onUserTranscript?: (text: string, isFinal: boolean) => void
  onAiTranscript?: (text: string, isFinal: boolean) => void
  onAiSpeaking?: () => void
  onAiDone?: () => void
  onUtteranceComplete?: (text: string) => void
  onError?: (err: Error) => void
  sttConfig?: DeepgramSTTConfig
}

interface VoiceSession {
  sendAudio: (pcmBuffer: Buffer) => void
  interrupt: () => void
  close: () => void
  readonly isActive: boolean
}
```

### Pipeline Flow

```
1. Audio in → stt.sendAudio(pcmBuffer)
2. Deepgram → onTranscript(text, isFinal) → if final + AI speaking + significant speech → interrupt()
3. Deepgram → onUtteranceEnd(fullText) → push {role:'user', content} to history
4. streamText(openai('gpt-4.1-mini'), system: voiceSystemPrompt, messages: history)
5. LLM textStream → tts.streamFromText() → PCM chunks via onAudioOut callback
6. Full response → push {role:'assistant', content} to history
```

### Voice System Prompt

The orchestrator wraps the spark's system prompt with conversation rules:

```
You are {sparkName}, having a real-time voice conversation.
Keep your responses natural and conversational.
Be concise — aim for 1-3 sentences per response unless asked for detail.
Don't use markdown, bullet points, numbered lists, or formatting that doesn't work in speech.
Don't use emojis, asterisks, or special characters.
Speak naturally as if talking to a friend or colleague.
Never mention that you are an AI or a language model.
```

### Echo Suppression

The orchestrator implements echo suppression to prevent the microphone picking up the AI's TTS output and transcribing it as user speech:
- Utterances received while `isAiSpeaking` is true are silently dropped
- After AI finishes speaking, utterances within `ECHO_GUARD_MS` (1500ms) are also dropped
- This prevents false "user speaking" triggers from speaker bleed-through

### Interruption Handling

Uses `isSignificantSpeech()` to filter out filler words before interrupting:
- Requires >= `MIN_INTERRUPT_WORDS` (2) words, OR a single non-filler word
- Filler words (uh, um, hmm, etc.) do NOT trigger interrupts
- Only triggers on **final** transcripts while `isAiSpeaking === true`

When interrupted:
1. `currentAbortController.abort()` fires, aborting both `streamText` and TTS
2. The `AbortError` is caught silently (not treated as error)
3. Partial AI response is saved to history with trailing `…` for context continuity
4. `isAiSpeaking` resets to false, `onAiDone()` fires

### Conversation History

- Messages accumulate in `conversationHistory: CoreMessage[]`
- No token-count limit or pruning — grows unbounded for session duration
- Partial responses on interrupt are preserved with `…` suffix
- History is lost when session closes (no persistence)

## Client Composables

### `useVoiceMode()` (`composables/voice/useVoiceMode.ts`)

Reactive state management for voice sessions.

**Exported refs:**
- `isActive`, `isConnecting`, `isConnected` -- session lifecycle
- `isMuted`, `isAiSpeaking`, `isUserSpeaking` -- activity state
- `userTranscript`, `aiTranscript` -- live transcription text
- `duration` -- seconds since connection (1s interval timer)
- `error` -- error string or null
- `hasPermission` -- microphone permission status (from useAudioCapture)
- `isPlayingBack` -- computed: whether audio is currently being played back

**Exported functions:**
- `start(sparkId)` -- get auth token, start mic capture, connect WebSocket, send `session.start`
- `stop()` -- send `end` message, cleanup
- `interrupt()` -- stop playback, send interrupt to server, throttled by `INTERRUPT_MIN_INTERVAL_MS`
- `toggleMute()` -- toggle `isMuted` ref, send `mute` message to server

**Constructor options (`VoiceModeOptions`):**
- `onUserSpeakingStart` -- fired when first user transcript arrives (for chat bridge)
- `onUserTranscriptUpdate` -- fired on each transcript update
- `onUserTurnComplete` -- fired when user utterance is complete
- `onAiTurnComplete` -- fired when AI finishes speaking (always, even on empty response)

**WebSocket connection flow:**
1. Get Supabase JWT from session (or refresh)
2. `audio.startCapture()` -- request microphone
3. Connect WebSocket to `/api/voice/browser-stream`
4. On `open`: send `session.start` with sparkId + token + locale (from cookie/localStorage)
5. On `message`: route to `handleMessage()` switch
6. `audio.onAudioChunk(base64 => ws.send({ type: 'audio', data: base64 }))` -- pipe mic to server
7. `audio.onVoiceDetected()` -- VAD-based client-side interrupt when AI is speaking

**Message handling:**
- `session.ready` → set `isConnected=true`, start duration timer
- `audio` → `audio.playAudio(data)` for gapless playback
- `transcript.user` → update `userTranscript`, set `isUserSpeaking=true`
- `transcript.ai` → accumulate `aiTranscript` (non-final) or set (final)
- `ai.speaking` → `isAiSpeaking=true`, clear `aiTranscript`
- `ai.done` → `isAiSpeaking=false`
- `error` → set `error` ref

**Cleanup:** Resets all refs, stops capture/playback, nullifies WebSocket handlers before closing.

### `useVoiceChatBridge()` (`composables/voice/useVoiceChatBridge.ts`)

Bridges voice mode events into the chat message stream and persists voice messages to the server.

- Accepts `VoiceChatBridgeOptions` with flowId, user info, spark ref, and messages store actions
- Returns six callback functions to wire into `useVoiceMode()`:
  - `onUserSpeakingStart` -- creates placeholder user message with streaming indicator
  - `onUserTranscriptUpdate` -- updates user message content as transcript arrives
  - `onUserTurnComplete` -- finalizes user message, persists to server
  - `onAiSpeakingStart` -- creates placeholder AI message with streaming indicator
  - `onAiTranscriptUpdate` -- updates AI message content
  - `onAiTurnComplete` -- finalizes AI message (or removes empty ghost), persists to server
- Persists messages to `POST /api/flows/{id}/voice-messages` for history retention
- Skips persistence for temp/preview flow IDs (not yet saved to DB)

### `useAudioCapture()` (`composables/voice/useAudioCapture.ts`)

See `{baseDir}/references/audio-processing.md` for full details.

## UI Components

### `VoiceWaveform.vue` (`components/workspace/voice/VoiceWaveform.vue`)

Animated bar waveform component.

**Props:**
- `active: boolean` (default: false) -- enables animation
- `barCount: number` (default: 5) -- number of bars
- `containerClass: string` (default: 'h-8')
- `barClass: string` (default: 'w-1 bg-white')
- `maxHeight: number` (default: 28px)
- `minHeight: number` (default: 4px)

**Bar height distribution:** Wave-like pattern where center bar is tallest. Uses `distance = abs(index - center)` with `ratio = 1 - (distance / center) * 0.5`.

**Animation:** CSS `voice-pulse` keyframe, 0.6s ease-in-out infinite alternate, scaleY(0.4 → 1). Each bar has `animationDelay: (i-1) * 80ms` for staggered wave effect.

### Layout Store Integration (`stores/layout.ts`)

Voice mode state in the layout store:
- `isVoiceModeActive: boolean` -- whether voice overlay is shown
- `voiceModeSparkId: string` -- which spark to connect to
- `setVoiceModeActive(active: boolean, sparkId?: string)` -- action to trigger voice mode

## Single-Shot Transcription (`server/api/voice/transcribe.post.ts`)

Separate from real-time voice mode. Uses OpenAI Whisper for one-off audio transcription.

**Input:** Multipart form data with `audio` field (any browser audio format, typically webm)
**Output:** `{ success: true, text: string, language: string }`
**Model:** `whisper-1`

## Batch Voice Classification (`server/api/cron/classify-spark-voices.post.ts`)

Migration/maintenance endpoint to classify voice gender for all sparks missing `callVoice`.
- Auth: `Bearer {CRON_SECRET}`
- Rate-limited: 200ms delay between classifications
- Returns detailed results with per-spark success/failure
