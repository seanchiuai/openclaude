# Voice System Troubleshooting

Known edge cases, error handling patterns, and debugging guide.

## Known Edge Cases

### 1 Session Per User Limit
`browser-stream.ts` enforces max 1 active voice session per user via `userActiveSessions` map. Opening a new session kills the previous one. This prevents orphaned sessions but means a user can't have voice mode open in two tabs.

### iOS Safari AudioContext Suspension
`AudioContext` starts in `'suspended'` state until a user gesture. Both `useAudioCapture.ts` (capture) and playback call `audioContext.resume()` if suspended. Voice mode must be triggered by a user click (which it is, via the UI button).

### Mute Is Client-Side Only
The `mute` message is sent to the server but the server does nothing with it. The client gates audio sending in `useVoiceMode.ts:92`:
```ts
if (ws?.readyState === WebSocket.OPEN && !isMuted.value) {
  ws.send(JSON.stringify({ type: 'audio', data: base64Pcm }))
}
```
Server-side STT stays open during mute — it just receives no data.

### Int16 Alignment
Fish Audio TTS chunks may have odd byte lengths. `alignedTts()` in `fish-audio-tts.ts` carries residual bytes across chunks to maintain 2-byte alignment. Without this, `Int16Array` interpretation would be shifted by one byte, producing garbage audio.

### Deepgram Buffer Slice
Node `Buffer.from()` may return a view into a shared `ArrayBuffer`. Sending `pcmBuffer.buffer` to Deepgram would send the entire shared buffer (potentially megabytes of wrong data). Must use:
```ts
pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength)
```

### Conversation History Unbounded
`orchestrator.ts` accumulates `conversationHistory: CoreMessage[]` with no limit. Long voice sessions could exceed LLM context window. Currently no pruning strategy is implemented.

### Automatic Reconnection with Keep-Alive
WebSocket connections now have:
- **Keep-alive heartbeat**: Client sends `ping` every 30s; server responds with `pong`
- **Pong timeout**: If no `pong` received within 10s, connection is considered dead
- **Automatic reconnection**: Exponential backoff (1s → 2s → 4s → 8s → 16s)
- **Session persistence**: Current sparkId, duration, and transcripts preserved during reconnection
- **HMR-awareness**: Session state saved to sessionStorage before page unload and automatically restored after Vite HMR reload (development only)

If the connection drops unexpectedly (network change, server restart), the client will automatically reconnect and resume the session. Intentional disconnects (user clicks stop) do not trigger reconnection.

### ScriptProcessorNode Deprecated
`useAudioCapture.ts` uses `ScriptProcessorNode` instead of `AudioWorklet` for broad compatibility. This runs on the main thread and may cause audio glitches under heavy load. Future improvement: migrate to AudioWorklet.

### Twilio Localhost Fallback
`webhook.post.ts` rewrites localhost `SITE_URL` to `staging.getminds.ai` for Twilio's WebSocket URL. Twilio can't reach localhost, so phone call testing requires a public URL or the staging environment.

### Playback Context Recreation
`stopPlayback()` closes the playback `AudioContext` but immediately creates a new one for future use. Without this, calling `playAudio()` after `stopPlayback()` would fail because `playbackContext` would be null.

## Error Handling Patterns

### Fish Audio 402 (Insufficient Credits)
Caught specifically in `orchestrator.ts:162-168`:
```ts
if (status === 402) {
  onError(new Error('Voice service requires credits. Please check your Fish Audio account.'))
  return  // Don't rethrow — graceful degradation
}
```
Other TTS errors are rethrown and handled by the outer catch.

### AbortError (User Interruption)
When the user speaks during AI response, `interrupt()` aborts the `streamText` call. The resulting `AbortError` is caught silently:
```ts
if (err?.name === 'AbortError' || signal.aborted) {
  console.log('[Voice Orchestrator] Response interrupted')
  return  // Not an error — expected behavior
}
```

### WebSocket Auth Failure
`browser-stream.ts` validates JWT via Supabase. On failure:
```ts
sendError(peer, 'Unauthorized')
peer.close(1008, 'Unauthorized')  // 1008 = Policy Violation
```

### Spark Not Found
Both `browser-stream.ts` and `stream.ts` check for spark existence:
- Browser: sends error message, doesn't close (lets client decide)
- Twilio: closes with `peer.close(1008, 'Spark not found')`

### Microphone Permission Errors
`useAudioCapture.ts` catches specific error names:
```ts
'NotAllowedError' | 'PermissionDeniedError' → error = 'microphone_denied'
'NotFoundError'                              → error = 'no_microphone'
```
These map to user-facing i18n strings in `VoiceMode.vue`.

### Voice Cloning Pipeline Errors
All pipeline steps are wrapped in try/catch. Any failure:
1. Sets `clonedVoiceStatus = 'failed'` on the spark
2. Returns `null`
3. Does not affect spark creation (best-effort, non-fatal)

Individual step failures log with `[Voice Cloning]` prefix and elapsed time for debugging.

## Debugging Guide

### Voice mode not connecting
1. Check browser console for WebSocket errors
2. Verify `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` env vars
3. Check server logs for `[VoiceWS]` messages
4. Ensure user has valid Supabase session/JWT

### No audio heard (AI not speaking)
1. Check `FISH_AUDIO_API_KEY` is set and has credits
2. Check `OPENAI_API_KEY` is set (orchestrator uses it for LLM)
3. Look for `[Voice Orchestrator]` errors in server logs
4. Check Fish Audio 402 errors (credit exhaustion)
5. Verify voice ID is valid: check spark's `clonedVoiceId`/`clonedVoiceStatus` or fallback env vars

### STT not transcribing
1. Check `DEEPGRAM_API_KEY` is set
2. Look for `[Deepgram STT]` connection/error logs
3. Verify audio format matches config (linear16, 24kHz, mono)
4. Check if mic is muted (client-side gating)
5. Test with `utterance_end_ms` — increase if utterances are getting cut off

### Voice cloning failed
1. Check `clonedVoiceStatus` on the spark (should be 'failed' with logs)
2. Search server logs for `[Voice Cloning]` + spark name
3. Step-by-step troubleshooting:
   - Step 2 failed: `APIFY_PROXY_PASSWORD` missing, yt-dlp not found, or YouTube bot detection
   - Step 3 failed: `DEEPGRAM_API_KEY` missing or audio too short for diarization
   - Step 5 failed: `ffmpeg` not available (check `ffmpeg-static` package)
   - Step 6 failed: `FISH_AUDIO_API_KEY` missing or credits exhausted

### Audio crackling/glitches
1. Check if `ScriptProcessorNode` buffer size is appropriate (4096 samples)
2. Verify gapless playback — `nextPlayTime` should advance smoothly
3. Check Int16 alignment issues (odd byte counts from Fish Audio)
4. Look for AudioContext state issues (suspended on iOS)

### Twilio calls not working
1. Verify `SITE_URL` is set to a public URL (not localhost)
2. Check Twilio webhook configuration points to `/api/voice/webhook`
3. Look for `[Voice]` and `[Voice Stream]` logs
4. Verify spark has a phone number assigned (`phoneNumber` field)
5. Check mulaw conversion — audio should be 8kHz mulaw for Twilio

### Voice sounds wrong (wrong voice for persona)
1. Check spark's `voiceProfile` JSON field in DB — verify archetype/gender match the persona
2. Look for `[VoicePool] Selected voice` logs with the spark ID
3. If pool voice is invalid, check `[VoiceValidator]` logs for recovery attempts
4. Run `POST /api/cron/validate-voice-pool` to check for expired Fish Audio voices
5. To regenerate: call `generateAndStoreVoiceProfile(sparkId, true)` with overwrite=true

### STT connection drops
1. Check `[DeepgramSTT] Reconnecting` logs — auto-reconnect handles transient drops
2. Verify reconnect attempts don't exceed `STT_MAX_RECONNECT_ATTEMPTS` (5)
3. If hitting max retries, check `DEEPGRAM_API_KEY` validity and Deepgram service status
4. Audio buffered during reconnection is limited to ~2s — longer outages lose audio

### Reconnection issues
1. Check browser console for "Reconnecting..." messages with attempt count
2. Verify WebSocket connection status in browser DevTools Network tab
3. Look for `ping`/`pong` messages in WebSocket frames (sent every 30s)
4. Check if error shows "Connection timeout" (no pong received within 10s)
5. Check sessionStorage for `voice-mode-session` key after HMR reload
6. Intentional disconnects (stop button) should NOT trigger reconnection

## Log Prefixes

| Prefix | Source |
|--------|--------|
| `[VoiceWS]` | `server/routes/api/voice/browser-stream.ts` |
| `[Voice Stream]` | `server/routes/api/voice/stream.ts` |
| `[Voice]` | `server/api/voice/webhook.post.ts` |
| `[Voice Orchestrator]` | `server/utils/voice/orchestrator.ts` |
| `[Deepgram STT]` | `server/utils/voice/deepgram-stt.ts` |
| `[Fish Audio TTS]` | `server/utils/voice/fish-audio-tts.ts` |
| `[Voice Cloning]` | `server/utils/voice-cloning/index.ts` |
| `[YouTube Audio]` | `server/utils/voice-cloning/youtube-audio.ts` |
| `[Speaker ID]` | `server/utils/voice-cloning/speaker-identification.ts` |
| `[Audio Extract]` | `server/utils/voice-cloning/audio-extract.ts` |
| `[Voice Clone]` | `server/utils/voice-cloning/clone-voice.ts` |
| `[Classifier]` | `server/utils/voice-classifier.ts` |
| `[PersonalityAnalyzer]` | `server/utils/voice/analyze-personality.ts` |
| `[VoicePool]` | `server/utils/voice/voice-pool.ts` |
| `[VoiceValidator]` | `server/utils/voice/validate-voice.ts` |
| `[Phase1Voice]` | `server/utils/voice-cloning/phase1-voice-track.ts` |
| `[YouTubeSearch]` | `server/utils/voice-cloning/youtube-search.ts` |
| `[EvalSources]` | `server/utils/voice-cloning/evaluate-sources.ts` |
| `[Voice Migration]` | `server/api/cron/classify-spark-voices.post.ts` |
| `[VoiceBackfill]` | `server/api/cron/backfill-voice-profiles.post.ts` |

## Performance Characteristics

| Operation | Typical Latency | Notes |
|-----------|----------------|-------|
| Deepgram STT (interim) | ~200-400ms | Near real-time via WebSocket |
| Deepgram utterance end | +1000ms | After last speech (configurable) |
| OpenAI LLM first token | ~300-600ms | gpt-4.1-mini, 300 max tokens |
| Fish Audio TTS first chunk | ~400-800ms | 'balanced' latency mode |
| End-to-end (speak → hear) | ~2-3s | STT + LLM + TTS combined |
| Voice cloning pipeline | ~60-180s | Dominated by YouTube download + Deepgram diarization |
| YouTube audio download | ~30-120s | yt-dlp via Apify residential proxy, up to 3 retries |
| Deepgram diarization | ~10-30s | Depends on audio length |
| Fish Audio model creation | ~10-20s | 'fast' train mode |

## Security Considerations

- **JWT validation**: Browser WebSocket validates Supabase JWT before allowing session start
- **Twilio webhook**: No auth on webhook endpoint (Twilio doesn't support custom auth headers). Consider adding Twilio signature validation.
- **CRON_SECRET**: Batch classification endpoint uses Bearer token auth
- **API keys**: All external service keys (Deepgram, Fish Audio, OpenAI, Apify) are server-side only, never exposed to client
- **In-memory state**: Session maps are per-process. In multi-process deployments, a user could have sessions on different processes (sticky sessions recommended)
