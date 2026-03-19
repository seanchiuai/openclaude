# Voice Cloning Pipeline Reference

Full 6-step voice cloning pipeline that creates a Fish Audio voice model from YouTube audio of a target person.

## Pipeline Overview

```
Step 1: rankVideosForCloning()     → LLM ranks YouTube sources by suitability
Step 2: downloadYouTubeAudio()     → yt-dlp downloads audio via Apify proxy as MP3
Step 3: identifySpeaker()          → Deepgram diarization + LLM picks target speaker
Step 4: selectBestSegmentsWithQuality() → Quality-score and pick segments >= 3s totaling ~40s
Step 5: extractAudioSegments()     → ffmpeg extracts each segment as WAV
Step 6: cloneVoice()               → Fish Audio creates voice model
```

## Entry Point (`server/utils/voice-cloning/index.ts`)

```ts
processVoiceCloning(
  sparkId: string,
  sparkName: string,
  youtubeSources: YouTubeSource[],
  existingTranscript?: string,
  sparkDescription?: string
): Promise<{ voiceId: string; provider: string } | null>
```

**Trigger:** Called by `server/workers/auto-spark.ts` as best-effort (non-fatal). Pipeline failures don't block spark creation.

**Database updates:**
- Start: `clonedVoiceStatus = 'processing'`, `clonedVoiceProvider = 'fish_audio'`
- Success: `clonedVoiceId = result.voiceId`, `clonedVoiceStatus = 'ready'`
- Failure: `clonedVoiceStatus = 'failed'`

**Timing:** Each step logs elapsed time for performance tracking.

## Step 1: Video Ranking (`rankVideosForCloning`)

Uses `gpt-4.1-mini` (temperature 0) to rank YouTube sources.

**Input:** Array of `{ url, title, transcriptLength }`

**LLM prompt strategy:**
- Prefers: keynotes, solo talks, long interviews where the person is the guest
- Avoids: news clips, compilations, videos where they barely speak, music videos
- Output format: comma-separated numbers (e.g., "2,1,3")

**Fallback:** If LLM fails or returns invalid output, uses original order.

**Edge case:** If only 1 source, skips ranking entirely.

## Step 2: YouTube Audio Download (`server/utils/voice-cloning/youtube-audio.ts`)

```ts
downloadYouTubeAudio(videoUrl: string): Promise<Buffer | null>
```

**Implementation:**
- Uses `yt-dlp` binary with Apify residential proxy (`groups-RESIDENTIAL` via `APIFY_PROXY_PASSWORD`)
- Uses `android_vr` player client with Node.js JS runtime (no YouTube cookies needed)
- Downloads full audio as MP3 (`-f worstaudio -x --audio-format mp3`)
- Trims to first 4 minutes locally with ffmpeg (stream copy, no re-encoding)
- Retries up to 3 times on bot detection or proxy/connection errors (fresh proxy IP each attempt)
- 5-minute timeout per download attempt

**yt-dlp binary resolution:** Checks `bin/yt-dlp` (DO App Platform build), `/usr/local/bin/yt-dlp`, `/usr/bin/yt-dlp`, `/opt/homebrew/bin/yt-dlp`, then falls back to PATH.

**Fallback on multiple sources:** The pipeline tries each ranked video in order until one produces a buffer > 10KB.

**Error handling:** Returns `null` on any failure. Retryable errors (proxy, bot detection) trigger retry with exponential delay (2s, 4s, 6s). Pipeline logs and tries next source.

## Step 3: Speaker Identification (`server/utils/voice-cloning/speaker-identification.ts`)

```ts
identifySpeaker(
  audioBuffer: Buffer,
  sparkName: string,
  existingTranscript?: string,
  sparkDescription?: string,
  videoTitle?: string
): Promise<{ speakerSegments: AudioSegment[]; confidence: number; transcriptText: string; targetWords: TargetWord[] } | null>
```

### Diarization

Uses Deepgram prerecorded API (not live) with `diarize: true`, wrapped in `retryDeepgram()` (up to 3 retries with exponential backoff for transient errors):

```ts
client.listen.prerecorded.transcribeFile(audioBuffer, {
  model: 'nova-3', language: 'multi', diarize: true, smart_format: true
})
```

Returns words with `speaker` labels (0, 1, 2...).

### Speaker Selection

**Single speaker:** Uses the only speaker found.

**Multiple speakers:** Calls `identifySpeakerWithLLM()`:
- Builds dialogue-style transcript excerpt via `buildDialogueExcerpt()` (up to 120 turns, sampled from beginning/middle/end)
- Includes per-speaker stats (airtime, word count, question count)
- LLM prompt loaded from Langfuse (`getVoiceSpeakerIdentificationPrompt`) with fallback inline prompt
- Accepts `videoTitle` for additional context
- Output: single speaker number
- **Fallback:** If LLM returns invalid number, picks speaker with most airtime who asks fewest questions (weighted score)

### Segment Extraction

Groups consecutive words from the target speaker into contiguous `AudioSegment[]`:

```ts
interface AudioSegment {
  startMs: number
  endMs: number
  speaker: number
}
```

**Segment merging:** After grouping, `mergeNearbySegments()` merges segments separated by < `MERGE_GAP_MS` (500ms) to prevent fragmentation from brief diarization errors.

**Confidence score:** `targetSpeakerAirtime / totalAirtime`. Pipeline proceeds even at low confidence (< 30%) with a warning.

### Pipeline Fallback

If `identifySpeaker` returns null or empty segments, the pipeline falls back to cloning using the **full audio** without speaker isolation.

## Step 4: Segment Selection (`selectBestSegmentsWithQuality`)

```ts
selectBestSegmentsWithQuality(
  audioBuffer: Buffer,
  segments: AudioSegment[],
  targetDurationMs: number = 40000,  // 40 seconds
  minSegmentMs: number = 3000        // 3 second minimum
): Promise<AudioSegment[]>
```

**Algorithm (quality-based):**
1. Filter out segments shorter than `minSegmentMs` (3s default)
2. Analyze each segment's audio quality via `audio-quality.ts` (volume, silence ratio, duration)
3. Score segments with weighted composite: duration (0.4), volume (0.3), silence (0.3)
4. Sort by quality score descending
5. Greedy pick until total reaches `targetDurationMs` (40s default)
6. Return selected in chronological order

**Fallback:** `selectBestSegmentsFallback()` — sorts by duration only (no quality analysis). Used when quality analysis fails.

## Step 5: Audio Extraction (`extractAudioSegments`)

```ts
extractAudioSegments(
  audioBuffer: Buffer,
  segments: AudioSegment[]
): Promise<Buffer[]>
```

**Implementation:**
1. Write full audio to temp file (`/tmp/voice-in-{uuid}.mp3`)
2. For each segment, run ffmpeg:
   ```
   ffmpeg -i input.mp3 -ss {start} -t {duration} -ar 44100 -ac 1 -y output.wav
   ```
3. Read each output WAV into a Buffer
4. Skip segments < `CLONE_MIN_SEGMENT_BYTES` (1KB, too small to be useful)
5. Clean up all temp files
6. Segments extracted in parallel batches of `CLONE_EXTRACTION_CONCURRENCY` (3)

**ffmpeg binary:** Uses `ffmpeg-static` npm package for bundled binary, falls back to system `ffmpeg`.

**Output format:** 44100 Hz, mono, WAV — chosen for Fish Audio compatibility.

**Timeout:** 30 seconds per segment via `execFile` timeout option.

## Step 6: Voice Cloning (`server/utils/voice-cloning/clone-voice.ts`)

```ts
cloneVoice(
  audioBuffers: Buffer[],
  sparkName: string,
  sparkId: string,
  transcriptTexts?: string[]
): Promise<{ voiceId: string; provider: 'fish_audio' } | null>
```

**Fish Audio API call:**
```ts
session.createModel({
  title: `Minds AI - ${sparkName}`,
  description: `Cloned voice for spark ${sparkId}`,
  visibility: 'private',
  type: 'tts',
  trainMode: 'fast',
  voices: audioBuffers,        // WAV segments
  enhanceAudioQuality: true,
  texts: transcriptTexts,      // Optional: must match buffer count
})
```

**Parameters explained:**
- `visibility: 'private'` -- not discoverable on Fish Audio platform
- `trainMode: 'fast'` -- quick training, good enough quality
- `enhanceAudioQuality: true` -- Fish Audio's noise reduction
- `voices` -- array of WAV buffers (multiple segments for better quality)
- `texts` -- optional transcript text matching each voice file (improves quality)

**Upload size guard:** Trims segments if total exceeds 15 MB to stay under Fish Audio's upload limit.

**Retry logic:** Retries up to 3 times on transient errors (502, 503, 504, rate limits) with 3-second delay between attempts. `enhanceAudioQuality` is disabled on retry attempts (Fish Audio preprocessing can trigger 502s).

**Returns:** `{ voiceId: model.id, provider: 'fish_audio' }`

## Voice Gender Classification (`server/utils/voice-classifier.ts`)

Separate from cloning but related — determines fallback voice when no clone exists.

### Classification

```ts
classifyVoiceGender(sparkName: string, systemPrompt?: string, description?: string): Promise<'male' | 'female'>
```

- Model: `gpt-4.1-mini`, temperature 0
- Primary signal: person's **name** (uses world knowledge of gendered names)
- Secondary signal: description and system prompt (first 500 chars)
- Fallback: `'male'` if ambiguous or on error
- Raw output is cleaned: `text.trim().toLowerCase().replace(/[^a-z]/g, '')`

### Batch Classification

```ts
classifyAndStoreVoiceGender(sparkId: string): Promise<VoiceGender | null>  // single
classifyVoicesForSparks(sparkIds: string[]): Promise<Map<string, VoiceGender>>  // batch, 100ms delay
```

### Voice ID Resolution

```ts
getVoiceId(spark): string
// 1. spark.clonedVoiceId if clonedVoiceStatus === 'ready'
// 2. voiceProfile.baseVoiceId (from personality analysis → voice pool)
// 3. FISH_AUDIO_FALLBACK_FEMALE_VOICE_ID if voiceGender === 'female'
// 4. FISH_AUDIO_FALLBACK_MALE_VOICE_ID
// 5. 'default'
```

## Data Flow Diagram

```
auto-spark.ts worker
  |
  +-- processVoiceCloning(sparkId, name, youtubeSources)
       |
       +-- Spark.clonedVoiceStatus = 'processing'
       |
       +-- Step 1: rankVideosForCloning(name, sources) → ranked[]
       |
       +-- Step 2: for source of ranked:
       |     downloadYouTubeAudio(url) → Buffer | null
       |     break on first success (> 10KB)
       |
       +-- Step 3: identifySpeaker(audioBuffer, name) → segments + confidence
       |     |-- Deepgram prerecorded (diarize=true)
       |     +-- LLM speaker identification (fallback: most airtime)
       |
       +-- Step 4: selectBestSegmentsWithQuality(audioBuffer, segments) → best[] (≥3s, ~40s total)
       |
       +-- Step 5: extractAudioSegments(audioBuffer, best) → WAV Buffer[]
       |     +-- ffmpeg -ss {start} -t {duration} -ar 44100 -ac 1
       |
       +-- Step 6: cloneVoice(wavBuffers, name, sparkId)
       |     +-- Fish Audio session.createModel()
       |
       +-- Spark.clonedVoiceId = model.id
       +-- Spark.clonedVoiceStatus = 'ready'
```

## Common Modifications

### Change target cloning duration
Edit `server/utils/voice/constants.ts` — `CLONE_TARGET_DURATION_MS` (default: 40000ms). More audio generally means better clone quality, but Fish Audio has upload limits.

### Change minimum segment length
Edit `audio-extract.ts:31` — `minSegmentMs` parameter (default: 3000ms). Shorter segments may have more noise/crosstalk.

### Use a different YouTube download method
Replace the implementation in `youtube-audio.ts` — must export `downloadYouTubeAudio(url): Promise<Buffer | null>`. Currently uses yt-dlp with Apify residential proxy. The pipeline only depends on this interface.

### Use a different voice cloning provider
Replace `clone-voice.ts` — must return `{ voiceId: string; provider: string }`. Update `voice-classifier.ts` `getVoiceId()` to handle the new provider's voice IDs.

### Add transcript-guided cloning
Pass `transcriptTexts` to `cloneVoice()` — one text string per audio buffer. Currently the pipeline has `speakerResult.transcriptText` available but doesn't pass it through to `cloneVoice()`. This would improve clone quality.

## Phase 1 Voice Track (`server/utils/voice-cloning/phase1-voice-track.ts`)

Runs in parallel with demo data collection for faster spark creation:

```
runPhase1VoiceTrack(sparkId, sparkName, entityName):
  1. analyzeVoicePersonality() → VoiceProfile (archetype, gender, speed, isCloneable)
  2. Store voiceProfile + voiceGender on Spark
  3. If !isCloneable → done (use pool voice)
  4. searchYouTubeForVoice(entityName) → search results
  5. evaluateYouTubeSources() → LLM filter + rank
  6. processVoiceCloning() → full 6-step pipeline
```

**YouTube Search** (`youtube-search.ts`): Uses Serper video search (primary) with Tavily as fallback. Queries: `{name} interview`, `{name} talk`, `{name} speech`, `{name} clip`. Filters out videos > 20 minutes.

**Source Evaluation** (`evaluate-sources.ts`): LLM filter ranks videos by suitability. Rejects news clips, compilations, and videos where the person barely speaks.

## Voice Pool System

### Personality Analysis (`server/utils/voice/analyze-personality.ts`)

Uses `gpt-4.1-mini` (temperature 0) with structured output (Zod schema) to classify:
- `gender`: male/female (name is strongest signal)
- `archetype`: authoritative | warm | energetic | analytical | creative | conversational
- `speed`: 0.8 (slow) to 1.2 (fast) — maps to TTS prosody
- `isCloneable`: whether this is a real public figure findable on YouTube

### Pool Selection (`server/utils/voice/voice-pool.ts`)

60 curated Fish Audio voices (38 male, 22 female), each tagged with archetypes and sonic traits. Selection algorithm:
1. Filter by gender + archetype (exclude accented voices by default)
2. Sub-filter by energy traits based on speed (calm tags for slow, energetic tags for fast)
3. Broaden to same-gender pool if archetype bucket is empty
4. Deterministic pick via djb2 hash of sparkId (same spark always gets same voice)

### Voice Validation (`server/utils/voice/validate-voice.ts`)

Pool voices are validated before use in voice sessions:
- GET request to Fish Audio model API, cached 1 hour (valid) or 5 minutes (invalid)
- If a pool voice is invalid (expired/removed), selects alternate from same archetype/gender bucket
- Updates the spark's `voiceProfile.baseVoiceId` with the replacement
- Non-pool voices (cloned, fallback, default) are not validated
