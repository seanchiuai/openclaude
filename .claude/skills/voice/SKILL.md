---
name: voice
description: Voice features including real-time voice mode, speech-to-text (Deepgram), text-to-speech (Fish Audio), voice cloning pipeline, Twilio phone calls, and voice gender classification. Use when working on any voice-related feature, debugging audio issues, or modifying the STT/LLM/TTS pipeline.
---

# Voice System

Real-time voice conversation mode with two transport paths: browser WebSocket and Twilio phone calls. Both share the same server-side orchestrator pipeline: Deepgram STT -> OpenAI LLM -> Fish Audio TTS. Voice cloning runs offline via an auto-spark worker. Voice selection uses a curated pool of 60 Fish Audio voices, matched to sparks via LLM personality analysis (archetype + gender + speed).

For detailed references, load files from `{baseDir}/references/`:
- `real-time-voice-mode.md` -- WebSocket protocol, browser/Twilio handlers, client composables, UI components
- `voice-cloning-pipeline.md` -- Full 6-step cloning pipeline: YouTube download -> diarization -> cloning
- `audio-processing.md` -- PCM capture/playback, mulaw conversion, format constants, Fish Audio TTS streaming
- `audio-quality-scoring.md` -- Audio quality metrics, segment scoring, quality-based selection (TARGET_DURATION_MS: 40s)
- `troubleshooting.md` -- Known edge cases, error handling patterns, debugging guide

## Architecture

```
                          +---------------------------------------------------+
                          |              Server (Nitro / crossws)              |
Browser --- WebSocket --->|  browser-stream.ts ---> orchestrator.ts            |
  (PCM16 24kHz base64)    |                          +-- deepgram-stt.ts       |
                          |                          +-- OpenAI GPT-4.1-mini   |
                          |                          +-- fish-audio-tts.ts     |
Twilio ---- WebSocket --->|  stream.ts ---> orchestrator.ts                    |
  (mulaw 8kHz base64)     |   (audio-convert: mulaw <-> PCM24k)               |
                          +---------------------------------------------------+

Voice Cloning (offline, triggered by auto-spark worker):
  YouTube URL -> yt-dlp download (Apify proxy, android_vr client) -> Deepgram diarization -> LLM speaker ID
  -> ffmpeg segment extraction -> Fish Audio clone -> store voiceId on Spark

Voice Pool (personality-matched selection):
  Spark creation -> LLM personality analysis (archetype, gender, speed, isCloneable)
  -> selectVoiceFromPool(archetype, gender, sparkId, speed) -> deterministic voice pick
  -> store VoiceProfile JSON on Spark
```

## Voice Mode Lifecycle

```
[idle] --start(sparkId)--> [connecting] --session.ready--> [connected/listening]
                                |                              |         |
                              error                     user speaks  AI speaks
                                |                              |         |
                                v                              v         v
                            [error] <----error----  [userSpeaking] [aiSpeaking]
                                                               |         |
                                                    utteranceEnd    ai.done
                                                               |         |
                                                               v         v
                                                          [listening] [listening]

[any state] --stop()/end--> [cleanup] --> [idle]
```

## Key Constants

All voice constants are centralized in two files:
- **Server:** `server/utils/voice/constants.ts` — STT, LLM, TTS, cloning, ffmpeg parameters
- **Client:** `composables/voice/constants.ts` — audio capture, VAD, WebSocket reconnection

| Constant | Value | Source |
|----------|-------|--------|
| `SAMPLE_RATE` | 24000 Hz | both constants.ts |
| `CHUNK_SIZE` | 4096 samples (~170ms) | client constants.ts |
| `UTTERANCE_END_MS` | 1000 ms | server constants.ts |
| `STT_MODEL` | `nova-3` | server constants.ts |
| STT encoding | `linear16`, 24kHz, mono | server constants.ts |
| `LLM_MODEL` | `gpt-4.1-mini` | server constants.ts |
| `LLM_TEMPERATURE` | 0.8 | server constants.ts |
| `LLM_MAX_OUTPUT_TOKENS` | 300 | server constants.ts |
| `TTS_FORMAT` / `TTS_SAMPLE_RATE` | `pcm`, 24kHz | server constants.ts |
| `TTS_LATENCY` | `'balanced'` | server constants.ts |
| `SENTENCE_BOUNDARY` | `/[.!?](?:\s\|$)/` | server constants.ts |
| `ECHO_GUARD_MS` | 1500 (echo suppression after AI speaks) | server constants.ts |
| `CLONE_OUTPUT_SAMPLE_RATE` | 44100 Hz, mono WAV | server constants.ts |
| `MIN_INTERRUPT_WORDS` | 2 | server constants.ts |
| `FILLER_WORDS` | uh, um, hmm, etc. | server constants.ts |
| `CLONE_TARGET_DURATION_MS` | 40s | server constants.ts |
| `CLONE_MIN_SEGMENT_MS` | 3000 (min segment length) | server constants.ts |
| `CLONE_MIN_SEGMENT_BYTES` | 1000 | server constants.ts |
| `CLONE_EXTRACTION_CONCURRENCY` | 3 | server constants.ts |
| `CLONE_ANALYSIS_CONCURRENCY` | 3 | server constants.ts |
| `FFMPEG_TIMEOUT_MS` | 30000 | server constants.ts |
| `FFMPEG_QUALITY_TIMEOUT_MS` | 15000 | server constants.ts |
| `STT_MAX_RECONNECT_ATTEMPTS` | 5 | server constants.ts |
| `STT_RECONNECT_DELAYS` | [500, 1000, 2000, 4000, 8000] | server constants.ts |
| `STT_AUDIO_BUFFER_MAX_BYTES` | ~96KB (~2s PCM16 24kHz) | server constants.ts |
| `DEEPGRAM_MAX_RETRIES` | 3 | server constants.ts |
| `DEEPGRAM_RETRY_BASE_MS` | 1000 | server constants.ts |
| `MERGE_GAP_MS` | 500 (merge same-speaker segments) | server constants.ts |
| `VAD_THRESHOLD_MULTIPLIER` | 3.0 (adaptive: noiseFloor x 3) | client constants.ts |
| `VAD_CONSECUTIVE_CHUNKS` | 2 (~340ms) | client constants.ts |
| `VAD_COOLDOWN_MS` | 300 ms | client constants.ts |
| `INTERRUPT_MIN_INTERVAL_MS` | 300 ms | client constants.ts |
| `RECONNECT_DELAYS` | [1000, 2000, 4000, 8000, 16000] | client constants.ts |
| `PING_INTERVAL` | 30000 ms | client constants.ts |
| `PONG_TIMEOUT` | 10000 ms | client constants.ts |

## Voice ID Resolution

```ts
// server/utils/voice-classifier.ts - getVoiceId(spark)
// Priority:
// 1. spark.clonedVoiceId (if clonedVoiceStatus === 'ready')
// 2. voiceProfile.baseVoiceId (from personality analysis → voice pool)
// 3. FISH_AUDIO_FALLBACK_FEMALE_VOICE_ID (if voiceGender === 'female')
// 4. FISH_AUDIO_FALLBACK_MALE_VOICE_ID
// 5. 'default' (absolute fallback)
//
// After resolution, pool voices are validated via validate-voice.ts:
//   validateAndRecoverVoiceId() checks Fish Audio API → if invalid,
//   selects alternate from same archetype/gender bucket, updates DB
```

## Database Model (Spark voice fields)

```prisma
model Spark {
  voiceId               String?   @map("voice_id")             // Legacy/generic voice ID
  phoneNumber           String?   @unique @map("phone_number") // Twilio phone number
  phoneNumberLastUsedAt DateTime? @map("phone_number_last_used_at")
  phoneNumberSid        String?   @map("phone_number_sid")     // Twilio SID for releasing
  callVoice             String?   @map("call_voice")           // Legacy: OpenAI Realtime voice
  clonedVoiceId         String?   @map("cloned_voice_id")      // Fish Audio cloned model ID
  clonedVoiceProvider   String?   @map("cloned_voice_provider")// 'fish_audio'
  clonedVoiceStatus     String?   @map("cloned_voice_status")  // 'pending'|'processing'|'ready'|'failed'
  voiceGender           String?   @map("voice_gender")         // 'male' | 'female'
  voiceProfile          Json?     @map("voice_profile")        // VoiceProfile: { archetype, baseVoiceId, speed, gender, isCloneable? }
}
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/voice/browser-stream` | WebSocket | Browser real-time voice (crossws) |
| `/api/voice/stream` | WebSocket | Twilio Media Streams (crossws) |
| `/api/voice/webhook` | POST | Twilio incoming call webhook, returns TwiML |
| `/api/voice/transcribe` | POST | Single-shot Whisper transcription (multipart form, `audio` field) |
| `/api/cron/reclone-voices` | POST | Triggers voice cloning for public sparks without working voice clones; supports `sparkIds` filter, `includeRetry`, `dryRun` (auth: `Bearer CRON_SECRET`) |
| `/api/cron/classify-spark-voices` | POST | Batch voice gender classification (auth: `Bearer CRON_SECRET`) |
| `/api/cron/backfill-voice-profiles` | POST | Generate voiceProfiles for sparks missing one (auth: `Bearer CRON_SECRET`) |
| `/api/cron/validate-voice-pool` | POST | Validate all Fish Audio voice IDs in the curated pool (auth: `Bearer CRON_SECRET`) |

## Environment Variables

| Variable | Service | Used By |
|----------|---------|---------|
| `DEEPGRAM_API_KEY` | STT (nova-3) + prerecorded diarization | deepgram-stt.ts, speaker-identification.ts |
| `FISH_AUDIO_API_KEY` | TTS + voice cloning | fish-audio-tts.ts, clone-voice.ts |
| `FISH_AUDIO_FALLBACK_MALE_VOICE_ID` | Default male TTS voice | voice-classifier.ts |
| `FISH_AUDIO_FALLBACK_FEMALE_VOICE_ID` | Default female TTS voice | voice-classifier.ts |
| `OPENAI_API_KEY` | LLM (orchestrator, speaker ID, gender classification, Whisper) | orchestrator.ts, speaker-identification.ts, voice-classifier.ts, transcribe.post.ts |
| `APIFY_PROXY_PASSWORD` | Residential proxy for yt-dlp | youtube-audio.ts |
| `SERPER_API_KEY` | YouTube video search (primary) | youtube-search.ts |
| `TAVILY_API_KEY` | YouTube video search (fallback) | youtube-search.ts |
| `SUPABASE_URL` | JWT validation in WS auth | browser-stream.ts |
| `SUPABASE_SERVICE_ROLE_KEY` | JWT validation in WS auth | browser-stream.ts |
| `SITE_URL` | Twilio WebSocket URL construction | webhook.post.ts |
| `CRON_SECRET` | Batch classification endpoint auth | classify-spark-voices.post.ts |

## File Map

### Server Pipeline
- `server/utils/voice/constants.ts` -- Centralized server-side voice constants (74 lines)
- `server/utils/voice/orchestrator.ts` -- STT -> LLM -> TTS pipeline manager with echo guard (232 lines)
- `server/utils/voice/deepgram-stt.ts` -- Deepgram Nova-3 live STT with auto-reconnect and audio buffering (185 lines)
- `server/utils/voice/fish-audio-tts.ts` -- Fish Audio TTS streaming with sentence chunking and prosody (117 lines)
- `server/utils/voice/logger.ts` -- Structured voice logging utility (56 lines)
- `server/utils/voice/voice-pool.ts` -- Curated pool of 60 Fish Audio voices with archetype/gender/trait matching (212 lines)
- `server/utils/voice/voice-profile.ts` -- VoiceProfile type, Zod schema, DB parser (44 lines)
- `server/utils/voice/analyze-personality.ts` -- LLM personality analysis for voice casting; `isCloneable` expanded to include fictional characters with iconic voices (SpongeBob, Darth Vader, Homer Simpson, Mario) (111 lines)
- `server/utils/voice/validate-voice.ts` -- Fish Audio voice ID validation with cache and pool recovery (131 lines)
- `server/utils/voice-classifier.ts` -- Voice ID resolution + LLM gender classification + profile generation (165 lines)
- `server/utils/audio-convert.ts` -- mulaw <-> PCM16 conversion with 3x resampling (171 lines)

### WebSocket Handlers
- `server/routes/api/voice/browser-stream.ts` -- Browser WS handler with voice profile, prosody, validation (240 lines)
- `server/routes/api/voice/stream.ts` -- Twilio Media Streams WS handler with voice profile, prosody (222 lines)

### REST Endpoints
- `server/api/voice/webhook.post.ts` -- Twilio incoming call webhook, TwiML (131 lines)
- `server/api/voice/transcribe.post.ts` -- Single-shot Whisper transcription (54 lines)
- `server/api/flows/[id]/voice-messages.post.ts` -- Persist voice messages to a flow (67 lines)
- `server/api/cron/reclone-voices.post.ts` -- Triggers voice cloning for public sparks without voice clones, with YouTube search (162 lines)
- `server/api/cron/classify-spark-voices.post.ts` -- Batch voice gender classification (90 lines)
- `server/api/cron/backfill-voice-profiles.post.ts` -- Generate voiceProfiles for sparks missing one (66 lines)
- `server/api/cron/validate-voice-pool.post.ts` -- Validate all Fish Audio voice IDs in the curated pool (72 lines)

### Voice Cloning Pipeline
- `server/utils/voice-cloning/index.ts` -- Full pipeline orchestrator (274 lines)
- `server/utils/voice-cloning/youtube-audio.ts` -- yt-dlp with Apify residential proxy, android_vr client (166 lines)
- `server/utils/voice-cloning/youtube-search.ts` -- YouTube search via Serper (primary) + Tavily (fallback) (177 lines)
- `server/utils/voice-cloning/evaluate-sources.ts` -- LLM-based source evaluation/ranking for cloning (101 lines)
- `server/utils/voice-cloning/speaker-identification.ts` -- Deepgram diarization + LLM speaker picking with retry (337 lines)
- `server/utils/voice-cloning/audio-extract.ts` -- ffmpeg segment extraction + quality-based selection with 15s cap (214 lines)
- `server/utils/voice-cloning/audio-quality.ts` -- Audio quality scoring (volume, silence, duration) (214 lines)
- `server/utils/voice-cloning/phase1-voice-track.ts` -- Phase 1: personality analysis + YouTube search + cloning (78 lines)
- `server/utils/voice-cloning/ffmpeg.ts` -- FFmpeg wrapper utility (37 lines)
- `server/utils/voice-cloning/clone-voice.ts` -- Fish Audio voice model creation with retry, disable enhance on retry (132 lines)

### Client
- `composables/voice/constants.ts` -- Centralized client-side voice constants (42 lines)
- `composables/voice/useVoiceMode.ts` -- Voice session lifecycle, WebSocket management, auto-reconnect, VAD interrupt (472 lines)
- `composables/voice/useAudioCapture.ts` -- Microphone capture (PCM16 24kHz), gapless playback, VAD (294 lines)
- `composables/voice/useVoiceChatBridge.ts` -- Bridges voice events into chat message stream, persists to server (141 lines)
- `components/workspace/voice/VoiceWaveform.vue` -- Animated bar waveform component (58 lines)

### State & Triggers
- `stores/layout.ts` -- `voiceModeSparkId`, `isVoiceModeActive`, `setVoiceModeActive()` action
- `server/workers/auto-spark.ts` -- Triggers voice profile generation + cloning (best-effort, non-fatal)

### Scripts & Tests
- `scripts/discover-voices.ts` -- Discover Fish Audio voices for curation (`npx tsx scripts/discover-voices.ts`)
- `scripts/fetch-pool-tags.ts` -- Fetch tags for current pool voices (`npx tsx scripts/fetch-pool-tags.ts`)
- `tests/test-voice-cloning-e2e.ts` -- E2E test: search -> download -> diarize -> extract -> clone (`npx tsx tests/test-voice-cloning-e2e.ts [name]`)

## Common Tasks

### Add a new voice provider
1. Create `server/utils/voice/<provider>-tts.ts` following the `fish-audio-tts.ts` pattern
2. Export `createXyzTTS(config)` returning `{ streamFromText, synthesize, close }`
3. Update `orchestrator.ts` to accept a provider selection in `VoiceSessionConfig`
4. Update `voice-classifier.ts` `getVoiceId()` if the new provider uses different voice IDs

### Change the LLM model for voice
Edit `server/utils/voice/constants.ts` -- change `LLM_MODEL`, `LLM_TEMPERATURE`, or `LLM_MAX_OUTPUT_TOKENS`. Keep `LLM_MAX_OUTPUT_TOKENS` low (~300) for conversational latency.

### Add a new WebSocket message type
1. Add the case to `handleMessage()` in `composables/voice/useVoiceMode.ts`
2. Add the corresponding server-side `sendMessage()` call in `browser-stream.ts`
3. Update the protocol table in `{baseDir}/references/real-time-voice-mode.md`

### Trigger voice cloning for a spark
Voice cloning has two paths:
1. **Phase 1** (parallel with demo collection): `runPhase1VoiceTrack()` in `server/utils/voice-cloning/phase1-voice-track.ts` — runs personality analysis, YouTube search, evaluation, and cloning in parallel with data collection.
2. **Fallback** (after collection): `server/workers/auto-spark.ts` checks if cloning was already done and runs `processVoiceCloning()` if not.

To trigger manually, call `processVoiceCloning(sparkId, sparkName, youtubeSources)` from `server/utils/voice-cloning/index.ts`.
