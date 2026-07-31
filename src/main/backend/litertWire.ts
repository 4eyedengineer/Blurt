/**
 * All assumptions about the LiteRT-LM sidecar's wire protocol live in this
 * one file, by design (see README "Slotting in the real backend"): every
 * function here is pure (no fetch/spawn/fs) so it's trivial to unit test
 * and trivial to adjust once the exact request/response shapes are
 * verified empirically against a real `litert-lm serve` instance.
 *
 * Verified against a real `litert-lm` 0.14.0 pip-installed server, from raw
 * req/resp captures:
 *   - `litert-lm serve` exposes an OpenAI-compatible
 *     `POST /v1/chat/completions`, with `stream: true` giving SSE
 *     (`text/event-stream`) chunks shaped like OpenAI's
 *     `chat.completion.chunk` objects, terminated by `data: [DONE]`. Matches
 *     exactly - no adjustments needed here.
 *   - Audio input is a user-message content part:
 *     `{ type: "input_audio", input_audio: { data: "<base64>", format: "wav" } }`.
 *     Confirmed correct, BUT: `format` is read and never validated/branched
 *     on server-side - the engine just base64-decodes `data` and requires it
 *     to be a real RIFF/WAV container (any declared sample rate works,
 *     no need to resample to 16kHz). Headerless/raw PCM16 (even with
 *     `format:"pcm16"` set) silently returns `content: null` - HTTP 200, no
 *     error. `pcm16ToWavBuffer` below already emits a proper 44-byte RIFF
 *     header, so this was correct from the start; documented here as a
 *     tripwire for anyone tempted to "optimize" it away.
 *   - `GET /v1/models` is available and used as the "is the server up yet"
 *     health check (see sidecar.ts) - confirmed, though note it returns 200
 *     almost immediately even before the model is actually loaded (loading
 *     is lazy, on first real inference request).
 *   - No `usage`/token-count field in any response, streamed or not - if
 *     that's ever needed, it has to be estimated client-side.
 *   - The server (`http.server.HTTPServer`, not `ThreadingHTTPServer`) is
 *     single-threaded: a second request literally blocks on the TCP accept
 *     until the first fully completes. `LitertBackend` enqueues every
 *     outgoing request through one app-wide serial queue for this reason -
 *     see `litertBackend.ts`.
 */
import type { TransformMode } from '../../shared/backend'

// ---------------------------------------------------------------------------
// Request types + builders
// ---------------------------------------------------------------------------

export type ChatMessageContentPart =
  | { type: 'text'; text: string }
  | { type: 'input_audio'; input_audio: { data: string; format: 'wav' } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatMessageContentPart[]
}

export interface ChatCompletionRequestBody {
  model: string
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
}

const TRANSCRIPTION_PROMPT =
  'Transcribe the following audio verbatim, exactly as spoken. Output only the raw transcription text - no commentary, no preamble, no quotation marks, no markdown formatting. If the audio is silent, contains only background noise, or does not contain any intelligible speech, output nothing at all (an empty string) - never guess, invent, or hallucinate words that are not clearly present in the audio.'

function vocabularyHint(vocabulary: string[] | undefined): string {
  const words = (vocabulary ?? []).map((w) => w.trim()).filter(Boolean)
  if (words.length === 0) return ''
  return ` The speaker commonly uses these terms - spell them correctly if you hear them: ${words.join(', ')}.`
}

export interface BuildTranscriptionRequestParams {
  model: string
  wavBase64: string
  vocabulary?: string[]
}

/** Builds a chat-completions request carrying a WAV blob as an `input_audio` content part. */
export function buildTranscriptionRequest(
  params: BuildTranscriptionRequestParams
): ChatCompletionRequestBody {
  return {
    model: params.model,
    stream: true,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIPTION_PROMPT + vocabularyHint(params.vocabulary) },
          { type: 'input_audio', input_audio: { data: params.wavBase64, format: 'wav' } }
        ]
      }
    ]
  }
}

const CLEANUP_SYSTEM_PROMPT = `You are a dictation cleanup assistant, in the style of Google's Eloquent app. You are given raw, unpunctuated speech-to-text output. Rewrite it into clean, readable text by:
- Removing filler words (um, uh, erm, like, you know) that are not meaningful content.
- Removing false starts, self-corrections, and repeated words/phrases (e.g. "I want- I want to go" -> "I want to go"; keep only the corrected version).
- Adding correct capitalization and punctuation.
- Preserving the speaker's meaning, wording, and tone otherwise - do not paraphrase, summarize, or add information.
Output ONLY the cleaned text. No preamble, no explanation, no quotation marks, no markdown.`

export interface BuildCleanupRequestParams {
  model: string
  text: string
  vocabulary?: string[]
}

export function buildCleanupRequest(params: BuildCleanupRequestParams): ChatCompletionRequestBody {
  const vocab = vocabularyHint(params.vocabulary)
  return {
    model: params.model,
    stream: true,
    temperature: 0.2,
    messages: [
      { role: 'system', content: CLEANUP_SYSTEM_PROMPT + (vocab ? `\n\n${vocab.trim()}` : '') },
      { role: 'user', content: params.text }
    ]
  }
}

const TRANSFORM_PROMPTS: Record<TransformMode, string> = {
  keypoints:
    'Rewrite the following text as a concise bullet-point summary of its key points, one bullet per point, using "- " as the bullet marker. Output ONLY the bullet list, nothing else.',
  formal:
    'Rewrite the following text in a more formal, professional register - expand contractions, remove slang, and tighten wording. Preserve the original meaning. Output ONLY the rewritten text, nothing else.',
  short:
    'Rewrite the following text to be significantly shorter and more concise, keeping only the essential meaning. Output ONLY the shortened text, nothing else.',
  long: 'Rewrite the following text with more detail and elaboration, expanding on its ideas while staying faithful to the original meaning. Output ONLY the expanded text, nothing else.'
}

export interface BuildTransformRequestParams {
  model: string
  text: string
  mode: TransformMode
}

export function buildTransformRequest(
  params: BuildTransformRequestParams
): ChatCompletionRequestBody {
  return {
    model: params.model,
    stream: true,
    temperature: 0.3,
    messages: [
      { role: 'system', content: TRANSFORM_PROMPTS[params.mode] },
      { role: 'user', content: params.text }
    ]
  }
}

/**
 * A minimal, non-streaming request whose only purpose is to force the
 * sidecar's lazy model load to happen up front instead of on the user's
 * first real utterance. Verified empirically that the first request against
 * a cold engine pays a multi-second load cost (~5.6s for E2B on CPU) vs.
 * ~1.4s once warm. Non-streaming so the caller doesn't need SSE plumbing
 * just to throw the result away.
 *
 * Includes a tiny (~0.3s) silent `input_audio` part alongside the text part,
 * not just text: per the HuggingFace model-card note, the audio submodel is
 * loaded lazily and *separately* from the text backbone to save memory, so a
 * text-only warmup does not force it to load - the user's first real
 * dictation utterance would otherwise still pay that hidden cold-start cost.
 * Silence is intentionally fine here (cheap to synthesize, cheap to
 * transcribe) - this is an internal warmup request, not a user session, so
 * `LitertBackend`'s silence guard (which exists to avoid hallucinated
 * "transcripts" from a broken mic capture path) does not apply and is never
 * consulted for this request.
 */
export function buildWarmupRequest(model: string): ChatCompletionRequestBody {
  return {
    model,
    stream: false,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Hi' },
          {
            type: 'input_audio',
            input_audio: { data: buildSilentWavBase64(), format: 'wav' }
          }
        ]
      }
    ]
  }
}

export interface BuildVoiceEditRequestParams {
  model: string
  text: string
  command: string
}

export function buildVoiceEditRequest(
  params: BuildVoiceEditRequestParams
): ChatCompletionRequestBody {
  return {
    model: params.model,
    stream: true,
    temperature: 0,
    messages: [
      {
        role: 'system',
        content:
          'You apply a spoken or typed edit command to a piece of text and return the edited result. Apply exactly what the command asks (e.g. replacing words, deleting a sentence, changing case) and change nothing else. Output ONLY the edited text, nothing else - no preamble, no explanation, no quotation marks.'
      },
      { role: 'user', content: `Text:\n${params.text}\n\nCommand: ${params.command}` }
    ]
  }
}

// ---------------------------------------------------------------------------
// Response / SSE parsing
// ---------------------------------------------------------------------------

export interface SSEEvent {
  event?: string
  data: string
}

/**
 * Splits a growing text buffer into complete SSE events (separated by a
 * blank line, per the SSE spec) plus whatever incomplete tail remains.
 * Pure/stateless: callers own the buffer and feed the returned remainder
 * back in on the next chunk.
 */
export function parseSSEBuffer(buffer: string): { events: SSEEvent[]; remainder: string } {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = parts.pop() ?? ''
  const events: SSEEvent[] = []

  for (const part of parts) {
    if (!part.trim()) continue
    let event: string | undefined
    const dataLines: string[] = []
    for (const line of part.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim()
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      }
      // Other SSE fields (id:, retry:, comments starting with ':') are
      // intentionally ignored - not needed for this protocol.
    }
    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') })
    }
  }

  return { events, remainder }
}

export function isStreamDone(rawData: string): boolean {
  return rawData.trim() === '[DONE]'
}

/** Defensive JSON.parse - never throws, returns null on malformed input. */
export function safeJsonParse(raw: string): unknown | null {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

interface ChatCompletionChunkShape {
  choices?: Array<{
    delta?: { content?: string | null }
    message?: { content?: string | null }
  }>
}

/**
 * Extracts the incremental text delta from one `chat.completion.chunk`-like
 * SSE payload. Falls back to `choices[0].message.content` (some servers
 * send the full message on the final chunk instead of a delta) so a minor
 * shape deviation doesn't silently drop output.
 */
export function extractDeltaFromChatCompletionChunk(json: unknown): string | null {
  const obj = json as ChatCompletionChunkShape
  const delta = obj?.choices?.[0]?.delta?.content
  if (typeof delta === 'string') return delta
  const full = obj?.choices?.[0]?.message?.content
  if (typeof full === 'string') return full
  return null
}

interface ChatCompletionResponseShape {
  choices?: Array<{ message?: { content?: string | null } }>
}

/** Extracts the full assistant reply from a non-streamed (single JSON body) chat-completions response. */
export function extractContentFromChatCompletionResponse(json: unknown): string | null {
  const obj = json as ChatCompletionResponseShape
  const content = obj?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : null
}

const PREAMBLE_LINE_PATTERN =
  /^(here('s| is)|sure[,!]?|certainly[,!]?|okay[,!]?|of course[,!]?)\b.*[:-]\s*$/i

/**
 * Best-effort cleanup of model output that ignores "output only the text"
 * instructions: strips `<think>...</think>` reasoning blocks, unwraps a
 * single wrapping markdown code fence, strips wrapping quotes, and drops a
 * leading "Here is the cleaned text:"-style preamble line if present.
 */
export function stripModelPreamble(text: string): string {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()

  const fenceMatch = out.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/)
  if (fenceMatch) {
    out = fenceMatch[1].trim()
  }

  const lines = out.split('\n')
  if (lines.length > 1 && PREAMBLE_LINE_PATTERN.test(lines[0].trim())) {
    lines.shift()
    out = lines.join('\n').trim()
  }

  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) {
    out = out.slice(1, -1).trim()
  }

  return out
}

// ---------------------------------------------------------------------------
// Audio encoding
// ---------------------------------------------------------------------------

/**
 * Root-mean-square amplitude of a PCM16 sample buffer, in raw int16 units
 * (0 .. ~32767). Used to detect an empty/near-silent accumulated capture
 * buffer before wasting a model call on it - a 44-byte WAV of pure silence
 * still gets *some* answer out of the model, which tends to be a confident
 * hallucination rather than an empty string (see LitertBackend's silence
 * guard).
 */
export function computeRms(samples: Int16Array): number {
  if (samples.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]
    sumSquares += s * s
  }
  return Math.sqrt(sumSquares / samples.length)
}

/** Concatenates PCM16 mono sample chunks (in push order) into one buffer. */
export function concatInt16(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, c) => sum + c.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

/**
 * Extracts one contiguous sub-range `[startMs, endMs)` of audio-time from
 * `chunks` (pushed in order), where `chunksStartMs` is the audio-time
 * position of the very first sample in `chunks[0]` - i.e. `chunks` doesn't
 * have to start at time zero, it's whatever trailing slice the caller kept.
 *
 * Only touches the chunks that actually overlap the requested range (skips
 * whole chunks outside it without copying their data), so as long as the
 * caller keeps `chunks` itself bounded to roughly the range it will ever
 * ask for (see `LitertBackend`'s `recentChunks` rolling buffer), this stays
 * cheap regardless of total session length - the whole point of the
 * rolling-window partial-tick design.
 *
 * Pure/stateless: rounds ms to the nearest sample, clamps `startMs` up to
 * `chunksStartMs` if it asks further back than `chunks` actually covers.
 */
export function sliceTrailingWindow(
  chunks: Int16Array[],
  chunksStartMs: number,
  sampleRate: number,
  startMs: number,
  endMs: number
): Int16Array {
  const clampedStartMs = Math.max(startMs, chunksStartMs)
  const startSample = Math.max(
    0,
    Math.round(((clampedStartMs - chunksStartMs) / 1000) * sampleRate)
  )
  const endSample = Math.max(startSample, Math.round(((endMs - chunksStartMs) / 1000) * sampleRate))

  const out = new Int16Array(endSample - startSample)
  let chunkStartSample = 0
  let outOffset = 0

  for (const chunk of chunks) {
    const chunkEndSample = chunkStartSample + chunk.length
    const takeStart = Math.max(startSample, chunkStartSample)
    const takeEnd = Math.min(endSample, chunkEndSample)
    if (takeEnd > takeStart) {
      out.set(chunk.subarray(takeStart - chunkStartSample, takeEnd - chunkStartSample), outOffset)
      outOffset += takeEnd - takeStart
    }
    chunkStartSample = chunkEndSample
    if (chunkStartSample >= endSample) break
  }

  return outOffset === out.length ? out : out.subarray(0, outOffset)
}

/**
 * ~0.3s of pure PCM16 silence, WAV-encoded and base64'd - used by
 * `buildWarmupRequest` to force the sidecar's audio submodel to load during
 * warmup instead of on the user's first real dictation. Deliberately cheap
 * (silence compresses/transcribes fast) since all this needs to do is touch
 * the audio code path, not produce a meaningful transcript.
 */
export function buildSilentWavBase64(durationMs = 300, sampleRate = 16000): string {
  const numSamples = Math.round((durationMs / 1000) * sampleRate)
  return pcm16ToWavBase64(new Int16Array(numSamples), sampleRate)
}

/** Encodes mono PCM16 samples as a standard 44-byte-header WAV file. */
export function pcm16ToWavBuffer(samples: Int16Array, sampleRate = 16000): Buffer {
  const numChannels = 1
  const bitsPerSample = 16
  const bytesPerSample = bitsPerSample / 8
  const blockAlign = numChannels * bytesPerSample
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * bytesPerSample

  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16) // fmt chunk size
  buffer.writeUInt16LE(1, 20) // audio format: 1 = PCM
  buffer.writeUInt16LE(numChannels, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(byteRate, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(bitsPerSample, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(dataSize, 40)

  for (let i = 0; i < samples.length; i++) {
    buffer.writeInt16LE(samples[i], 44 + i * bytesPerSample)
  }

  return buffer
}

export function pcm16ToWavBase64(samples: Int16Array, sampleRate = 16000): string {
  return pcm16ToWavBuffer(samples, sampleRate).toString('base64')
}
