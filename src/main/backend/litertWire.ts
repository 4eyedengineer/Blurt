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
 *   - Audio input was a user-message content part,
 *     `{ type: "input_audio", input_audio: { data: "<base64>", format: "wav" } }`,
 *     and worked: the engine base64-decodes `data` and requires a real
 *     RIFF/WAV container at any sample rate (headerless PCM16 silently
 *     returns `content: null` on an HTTP 200). Nothing sends audio to the
 *     LLM any more - transcription moved to a dedicated recogniser on the
 *     same sidecar process (see resources/asr.py) - so the request type and
 *     its builders are gone rather than kept warm. Recorded here because it
 *     is a verified fact about this server that would otherwise have to be
 *     rediscovered, not because anything still depends on it.
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

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  /** Always plain text. The multi-part content array only ever existed to carry `input_audio`, which nothing sends any more - see this file's header. */
  content: string
}

export interface ChatCompletionRequestBody {
  model: string
  messages: ChatMessage[]
  stream: boolean
  temperature?: number
}

function vocabularyHint(vocabulary: string[] | undefined): string {
  const words = (vocabulary ?? []).map((w) => w.trim()).filter(Boolean)
  if (words.length === 0) return ''
  return ` The speaker commonly uses these terms - spell them correctly if you hear them: ${words.join(', ')}.`
}

/**
 * Written for text that has ALREADY been punctuated by the recogniser.
 *
 * The previous version opened "You are given raw, unpunctuated speech-to-text
 * output" - true when Gemma itself did the transcribing, and false the moment
 * a dedicated recogniser took over (see resources/asr.py). Parakeet returns
 * correct punctuation, capitalization and number formatting, so this prompt
 * was handing a model finished prose, telling it the prose was raw, and
 * asking it to clean it up. With nothing legitimate left to fix, it invented
 * work: expanding contractions ("It's" -> "It is"), swapping conjunctions
 * ("as" -> "because"), and deleting hedges the speaker actually said
 * ("any sort of words" -> "any words"). All three observed in real
 * dictations, and all three forbidden by the old prompt's own closing line -
 * which is the tell that the problem was the premise, not the rules.
 *
 * Hence the explicit prohibitions and, most importantly, the line giving the
 * model permission to do nothing. "Rewrite this" with no defects present is
 * an instruction to change something; "return it verbatim, that is the
 * expected outcome" is not.
 */
const CLEANUP_SYSTEM_PROMPT = `You are a dictation cleanup assistant. The text you are given already comes from a speech recognizer that produced correct punctuation, capitalization and number formatting. It is NOT raw unpunctuated output, and it usually needs very little changing.

Your only job is to remove disfluency:
- Filler words (um, uh, erm) that carry no meaning.
- False starts and self-corrections (e.g. "I want- I want to go" -> "I want to go"; keep only the corrected version).
- Accidentally repeated words.

Change NOTHING else. Specifically:
- Keep contractions exactly as spoken. Do not expand "it's" to "it is".
- Keep the speaker's own word choices. Do not swap "as" for "because", or replace any word with a synonym.
- Keep hedges and qualifiers like "really", "sort of", "quite", "just" - these are how the speaker talks.
- Do not restructure, reorder, merge or split sentences that are already grammatical.

If the text contains no disfluency, return it completely unchanged. Returning the input verbatim is the correct and expected outcome most of the time.

Output ONLY the text. No preamble, no explanation, no quotation marks, no markdown.`

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
 * Text only, deliberately. This used to also carry ~0.3s of silent
 * `input_audio`, because the audio submodel loads lazily and separately from
 * the text backbone (per the HuggingFace model card) and a text-only warmup
 * leaves it cold. That was the right thing to do while Gemma did the
 * transcribing. It no longer does (see resources/asr.py), so the audio part
 * was paying to pull a multi-GB submodel into memory at every startup to
 * warm a path nothing calls. What the LLM is actually asked for now -
 * cleanup, transforms, voice edit - is all text, and the text backbone is
 * what this warms.
 */
export function buildWarmupRequest(model: string): ChatCompletionRequestBody {
  return {
    model,
    stream: false,
    temperature: 0,
    messages: [{ role: 'user', content: 'Hi' }]
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
