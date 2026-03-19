# Audio Processing Reference

Detailed reference for audio capture, playback, format conversion, and TTS streaming.

## Audio Formats in the System

| Context | Format | Sample Rate | Channels | Encoding |
|---------|--------|-------------|----------|----------|
| Browser mic capture | PCM16 | 24 kHz | mono | linear16 (Int16) |
| Browser playback | PCM16 | 24 kHz | mono | linear16 (Int16) |
| WebSocket transport (browser) | base64 string | 24 kHz | mono | PCM16 to base64 |
| WebSocket transport (Twilio) | base64 string | 8 kHz | mono | mulaw to base64 |
| Deepgram STT input | PCM16 | 24 kHz | mono | linear16 |
| Fish Audio TTS output | PCM | 24 kHz | mono | linear16 |
| Fish Audio clone input | WAV | 44.1 kHz | mono | -- |
| Twilio Media Streams | mulaw (G.711) | 8 kHz | mono | mu-law |

## Client Audio Capture (`composables/voice/useAudioCapture.ts`)

### Microphone Capture

```ts
const SAMPLE_RATE = 24000
const CHUNK_SIZE = 4096  // samples per chunk (~170ms at 24kHz)

// Capture pipeline:
// getUserMedia -> AudioContext(24kHz) -> ScriptProcessorNode(4096)
// -> Float32 [-1,1] -> Int16 PCM -> base64 -> callback
```

**MediaStream constraints:**
```ts
{ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 24000 } }
```

**Float32 to Int16 conversion:**
```ts
const s = Math.max(-1, Math.min(1, inputData[i]))
pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF
```

**Base64 encoding (browser-safe, no Node Buffer):**
```ts
function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i])
  }
  return btoa(binary)
}
```

Uses `ScriptProcessorNode` (deprecated) instead of `AudioWorklet` for broad browser compatibility, including older Safari versions.

### Gapless Audio Playback

Audio chunks from the server must play back seamlessly without gaps or clicks.

```ts
// Playback pipeline:
// base64 -> Uint8Array -> Int16Array -> Float32Array -> AudioBuffer -> BufferSource

// Scheduling: each buffer starts at `nextPlayTime`, which advances by buffer duration
const currentTime = playbackContext.currentTime
if (nextPlayTime < currentTime) nextPlayTime = currentTime
source.start(nextPlayTime)
nextPlayTime += audioBuffer.duration
```

**Int16 to Float32 conversion (playback):**
```ts
float32[i] = pcm16[i] / 0x8000
```

**Int16 alignment on playback:**
```ts
const alignedLength = raw.length - (raw.length % 2)  // ensure even byte count
const pcm16 = new Int16Array(raw.buffer, raw.byteOffset, alignedLength / 2)
```

### iOS Safari Handling

Both capture and playback AudioContext may be in `'suspended'` state until a user gesture:
```ts
if (audioContext.state === 'suspended') {
  await audioContext.resume()
}
```

### Error States

| Error Name | Meaning | State Set |
|------------|---------|-----------|
| `NotAllowedError` / `PermissionDeniedError` | User denied mic permission | `error = 'microphone_denied'`, `hasPermission = false` |
| `NotFoundError` | No microphone device found | `error = 'no_microphone'` |
| Other | Unknown capture error | `error = err.message` |

### Cleanup

`stopCapture()`:
1. Disconnect `ScriptProcessorNode`
2. Disconnect `MediaStreamAudioSourceNode`
3. Close `AudioContext`
4. Stop all `MediaStream` tracks (releases mic indicator)

`stopPlayback()`:
1. Close playback `AudioContext`
2. Clear queue, reset `nextPlayTime`
3. Re-create AudioContext for future use (if in browser)

## Mulaw / PCM Conversion (`server/utils/audio-convert.ts`)

### Lookup Tables

Pre-computed at module load for zero-allocation conversion:

```ts
const MULAW_TO_LINEAR: Int16Array = new Int16Array(256)     // 8-bit mulaw to 16-bit PCM
const LINEAR_TO_MULAW: Uint8Array = new Uint8Array(65536)   // 16-bit PCM to 8-bit mulaw
```

### mulaw to PCM24k (`mulawToPcm24k`)

```
1. Base64 decode mulaw
2. Lookup table: each mulaw byte to Int16 sample (8kHz PCM)
3. Upsample 3x: linear interpolation (8kHz to 24kHz)
4. Base64 encode PCM
```

**3x upsampling (linear interpolation):**
```ts
// For each input sample pair (curr, next):
output[i*3]     = curr
output[i*3 + 1] = curr + round(diff / 3)
output[i*3 + 2] = curr + round(diff * 2 / 3)
```

### PCM24k to mulaw (`pcm24kToMulaw`)

```
1. Base64 decode PCM
2. Downsample 3x: average of 3 consecutive samples (24kHz to 8kHz)
3. Lookup table: each Int16 sample to mulaw byte
4. Base64 encode mulaw
```

**3x downsampling (averaging):**
```ts
output[i] = round((input[i*3] + input[i*3+1] + input[i*3+2]) / 3)
```

### Silent Audio Generation

```ts
createSilentMulaw(durationMs)  // 8 samples/ms, filled with 0xFF (mulaw silence)
createSilentPcm24k(durationMs) // 24 samples/ms * 2 bytes, filled with 0x00
```

## Fish Audio TTS Streaming (`server/utils/voice/fish-audio-tts.ts`)

### Session Setup

```ts
import { Session, TTSRequest } from 'fish-audio-sdk'

interface FishAudioTTSConfig {
  voiceId: string
  format?: 'pcm' | 'mp3' | 'wav' | 'opus'
  sampleRate?: number
  latency?: 'normal' | 'balanced'
  prosody?: { speed: number }
}

const session = new Session(apiKey)

function createRequest(text: string) {
  return new TTSRequest(text, {
    referenceId: voiceId,   // Fish Audio voice model ID
    format: 'pcm',          // raw PCM output
    sampleRate: 24000,
    latency: 'balanced',    // 'normal' | 'balanced'
    ...(prosody ? { prosody } : {}),  // Optional speed override from voice profile
  })
}
```

### Sentence-Chunked Streaming (`streamFromText`)

LLM output arrives as small text chunks. The TTS accumulates text until a sentence boundary, then synthesizes each complete sentence:

```ts
const SENTENCE_BOUNDARY = /[.!?](?:\s|$)/

async function* streamFromText(textStream: AsyncIterable<string>): AsyncGenerator<Buffer> {
  let buffer = ''
  for await (const chunk of textStream) {
    buffer += chunk
    // Find and synthesize complete sentences
    let match = SENTENCE_BOUNDARY.exec(buffer)
    while (match) {
      const sentence = buffer.substring(0, match.index + 1).trim()
      buffer = buffer.substring(match.index + 1).trim()
      if (sentence) yield* alignedTts(sentence)
      match = SENTENCE_BOUNDARY.exec(buffer)
    }
  }
  // Synthesize remaining text (incomplete sentence)
  if (buffer.trim()) yield* alignedTts(buffer.trim())
}
```

**Why sentence chunking?** Synthesizing word-by-word would produce poor prosody. Full-text synthesis would add too much latency (wait for entire LLM response). Sentence-level is a good balance.

### Int16 Alignment (`alignedTts`)

Fish Audio may return PCM chunks with odd byte counts, which would corrupt Int16 interpretation. The `alignedTts` generator handles this:

```ts
async function* alignedTts(text: string): AsyncGenerator<Buffer> {
  let residual: Buffer | null = null
  for await (const chunk of session.tts(request)) {
    let data = chunk as Buffer
    if (residual) { data = Buffer.concat([residual, data]); residual = null }
    if (data.length % 2 !== 0) {
      residual = data.subarray(data.length - 1)
      data = data.subarray(0, data.length - 1)
    }
    if (data.length > 0) yield data
  }
  // Discard single trailing byte (incomplete sample)
}
```

### Single-Shot Synthesis

```ts
async function* synthesize(text: string): AsyncGenerator<Buffer> {
  yield* alignedTts(text)
}
```

Used for one-off TTS (not streaming from LLM). Currently not called by the voice pipeline but available.

## Deepgram STT (`server/utils/voice/deepgram-stt.ts`)

### Connection Setup

```ts
const connection = client.listen.live({
  model: 'nova-3',
  language: 'multi',
  smart_format: true,          // auto-punctuation and formatting
  utterance_end_ms: 1000,      // 1s silence = utterance complete
  interim_results: true,       // real-time partial transcripts
  encoding: 'linear16',
  sample_rate: 24000,
  channels: 1,
})
```

### Handlers Interface

```ts
interface DeepgramSTTHandlers {
  onTranscript: (text: string, isFinal: boolean) => void
  onUtteranceEnd: (fullText: string) => void
  onError: (err: Error) => void
}
```

### Events

| Event | Handling |
|-------|---------|
| `Open` | Set `isOpen = true`, log |
| `Transcript` | If final + non-empty: append to `utteranceBuffer`. Call `onTranscript(text, isFinal)` |
| `UtteranceEnd` | If buffer non-empty: call `onUtteranceEnd(buffer)`, reset buffer |
| `Error` | Log, call `onError(err)` |
| `Close` | Set `isOpen = false`, trigger auto-reconnect if not intentional |

### Auto-Reconnect

The Deepgram STT wrapper automatically reconnects with exponential backoff if the WebSocket connection drops:
- Max `STT_MAX_RECONNECT_ATTEMPTS` (5) attempts with delays [500, 1000, 2000, 4000, 8000]ms
- Audio received during reconnection is buffered (bounded at `STT_AUDIO_BUFFER_MAX_BYTES` ~2s of PCM16 24kHz) and flushed on reconnect
- Any accumulated utterance buffer is flushed as `onUtteranceEnd` before reconnecting to avoid losing user speech
- The reconnection is transparent to the orchestrator -- it just sees a brief gap in transcripts

### Sending Audio

**Critical:** Node `Buffer` may share underlying `ArrayBuffer` with other buffers. Must extract the correct slice:

```ts
connection.send(
  pcmBuffer.buffer.slice(pcmBuffer.byteOffset, pcmBuffer.byteOffset + pcmBuffer.byteLength)
)
```

Sending `pcmBuffer.buffer` directly would send the wrong data if the Buffer is a view into a larger ArrayBuffer.

### Utterance Buffer

Accumulates final transcripts across multiple Deepgram `Transcript` events until `UtteranceEnd`:

```
Transcript(final, "Hello")      -> buffer = "Hello"
Transcript(final, "how are you") -> buffer = "Hello how are you"
UtteranceEnd                     -> onUtteranceEnd("Hello how are you"), buffer = ""
```

This combines sentence fragments into complete user utterances before sending to the LLM.

## ffmpeg Segment Extraction (`server/utils/voice-cloning/audio-extract.ts`)

Extracts audio segments from a full recording for voice cloning.

### Segment Selection Algorithm

```ts
selectBestSegmentsWithQuality(audioBuffer, segments, targetDurationMs = 40000, minSegmentMs = 3000)
```

1. Filter segments shorter than 3 seconds
2. Analyze each segment's audio quality via `audio-quality.ts`
3. Score with weighted composite: duration (0.4), volume (0.3), silence ratio (0.3)
4. Drop segments below `CLONE_MIN_QUALITY_SCORE` (0.25)
5. Greedy pick from best scores until 40s target reached
6. Return selected in chronological order

Fallback: `selectBestSegmentsFallback()` sorts by duration only (no quality analysis).

### ffmpeg Command

For each segment, with audio preprocessing:
```
ffmpeg -i input.mp3 -ss {startSec} -t {durationSec} -ar 44100 -ac 1 -y output.wav
```

- `-ar 44100` -- resample to 44.1kHz (Fish Audio requirement)
- `-ac 1` -- mono channel
- `-y` -- overwrite output
- 30-second timeout per segment

Uses `ffmpeg-static` npm package for bundled binary, falls back to system ffmpeg.

### Temp File Management

- Input: `/tmp/voice-in-{uuid}.mp3`
- Segments: `/tmp/voice-seg-{uuid}.wav`
- All temp files cleaned up in `finally` block
- Segments smaller than 1KB are skipped
