import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type {
  AudioChunk,
  BackendError,
  BackendErrorSource,
  InferenceBackend,
  StartSessionOptions,
  TransformMode
} from '../../shared/backend'
import {
  buildCleanupRequest,
  buildTranscriptionRequest,
  buildTransformRequest,
  buildVoiceEditRequest,
  concatInt16,
  extractContentFromChatCompletionResponse,
  extractDeltaFromChatCompletionChunk,
  isStreamDone,
  parseSSEBuffer,
  pcm16ToWavBase64,
  safeJsonParse,
  stripModelPreamble,
  type ChatCompletionRequestBody
} from './litertWire'

/** How often (ms of *new* audio, not wall-clock time) to fire a partial re-transcription. */
const DEFAULT_PARTIAL_INTERVAL_MS = 3000
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SAMPLE_RATE = 16000

interface LitertSession {
  id: string
  sampleRate: number
  chunks: Int16Array[]
  msSinceLastPartial: number
  hasAudio: boolean
  partialInFlight: boolean
  lastTranscript: string
  ended: boolean
  vocabulary?: string[]
}

export interface LitertBackendOptions {
  /** Resolved lazily on every request so a sidecar restart/port change is picked up transparently. */
  getBaseUrl: () => string
  /** Sent as the `model` field on every request; the sidecar has one model loaded regardless. */
  modelId: string
  getVocabulary?: () => string[]
  partialIntervalMs?: number
  requestTimeoutMs?: number
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * `InferenceBackend` implementation backed by a LiteRT-LM sidecar HTTP
 * server (`litert-lm serve`, OpenAI-compatible). See litertWire.ts for the
 * request/response shapes this assumes - keep those isolated there so
 * they're easy to adjust once verified against a real server.
 */
export class LitertBackend implements InferenceBackend, BackendErrorSource {
  private sessions = new Map<string, LitertSession>()
  private emitter = new EventEmitter()
  private readonly partialIntervalMs: number
  private readonly requestTimeoutMs: number

  constructor(private readonly options: LitertBackendOptions) {
    this.partialIntervalMs = options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async startSession(opts?: StartSessionOptions): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, {
      id,
      sampleRate: opts?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      chunks: [],
      msSinceLastPartial: 0,
      hasAudio: false,
      partialInFlight: false,
      lastTranscript: '',
      ended: false,
      vocabulary: opts?.vocabulary ?? this.options.getVocabulary?.()
    })
    return id
  }

  pushAudio(sessionId: string, chunk: AudioChunk): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) return

    if (!(chunk instanceof Int16Array)) {
      // Opaque/compressed (e.g. webm) fallback chunk - we can't decode this
      // into PCM for a WAV upload without a codec, so it's dropped. This
      // only happens when AudioWorklet is unavailable in the renderer; see
      // README "Known deviations".
      return
    }

    session.chunks.push(chunk)
    session.hasAudio = true
    session.msSinceLastPartial += (chunk.length / session.sampleRate) * 1000

    if (session.msSinceLastPartial >= this.partialIntervalMs && !session.partialInFlight) {
      session.msSinceLastPartial = 0
      void this.runPartialTranscription(session)
    }
  }

  private async runPartialTranscription(session: LitertSession): Promise<void> {
    session.partialInFlight = true
    try {
      const text = await this.transcribe(session)
      if (!session.ended) {
        session.lastTranscript = text
        this.emitter.emit('partial', session.id, text)
      }
    } catch (err) {
      this.emitError(session.id, err)
    } finally {
      session.partialInFlight = false
    }
  }

  private async transcribe(session: LitertSession): Promise<string> {
    const wavBase64 = pcm16ToWavBase64(concatInt16(session.chunks), session.sampleRate)
    const request = buildTranscriptionRequest({
      model: this.options.modelId,
      wavBase64,
      vocabulary: session.vocabulary
    })
    const raw = await this.chatCompletion(request)
    return stripModelPreamble(raw)
  }

  async endSession(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) return ''
    session.ended = true
    this.sessions.delete(sessionId)

    if (!session.hasAudio) return session.lastTranscript

    // Serialize with any still-in-flight partial rather than racing it -
    // both would hit the same sidecar session-less endpoint concurrently
    // otherwise. Bounded by requestTimeoutMs so a stuck partial can't hang
    // endSession forever.
    const deadline = Date.now() + this.requestTimeoutMs
    while (session.partialInFlight && Date.now() < deadline) {
      await sleep(50)
    }

    try {
      return await this.transcribe(session)
    } catch (err) {
      this.emitError(sessionId, err)
      return session.lastTranscript
    }
  }

  onPartialTranscript(listener: (sessionId: string, text: string) => void): () => void {
    this.emitter.on('partial', listener)
    return () => this.emitter.off('partial', listener)
  }

  onError(listener: (sessionId: string, error: BackendError) => void): () => void {
    this.emitter.on('session-error', listener)
    return () => this.emitter.off('session-error', listener)
  }

  private emitError(sessionId: string, err: unknown): void {
    this.emitter.emit('session-error', sessionId, toBackendError(err))
  }

  async cleanup(text: string): Promise<string> {
    const request = buildCleanupRequest({
      model: this.options.modelId,
      text,
      vocabulary: this.options.getVocabulary?.()
    })
    const raw = await this.chatCompletion(request)
    return stripModelPreamble(raw)
  }

  async transform(text: string, mode: TransformMode): Promise<string> {
    const request = buildTransformRequest({ model: this.options.modelId, text, mode })
    const raw = await this.chatCompletion(request)
    return stripModelPreamble(raw)
  }

  async voiceEdit(text: string, command: string): Promise<string> {
    const request = buildVoiceEditRequest({ model: this.options.modelId, text, command })
    const raw = await this.chatCompletion(request)
    return stripModelPreamble(raw)
  }

  /**
   * Sends a chat-completions request and returns the full assistant reply.
   * Always requests `stream: true` (per the design's SSE-first approach)
   * but defensively falls back to parsing a plain JSON body if the server
   * doesn't actually stream (e.g. content-type isn't text/event-stream) -
   * see litertWire.ts's guards.
   */
  private async chatCompletion(body: ChatCompletionRequestBody): Promise<string> {
    const baseUrl = this.options.getBaseUrl()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs)

    let res: Response
    try {
      res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
    } catch (err) {
      clearTimeout(timer)
      if (err instanceof Error && err.name === 'AbortError') {
        throw new TimeoutBackendError(`Sidecar request timed out after ${this.requestTimeoutMs}ms`)
      }
      throw new SidecarUnreachableError(
        `Could not reach the LiteRT-LM sidecar at ${baseUrl}: ${
          err instanceof Error ? err.message : String(err)
        }`
      )
    }

    try {
      if (!res.ok) {
        const errText = await safeText(res)
        throw new RequestFailedError(
          `Sidecar returned HTTP ${res.status}${errText ? `: ${errText.slice(0, 300)}` : ''}`
        )
      }

      const contentType = res.headers.get('content-type') ?? ''
      if (!contentType.includes('text/event-stream') || !res.body) {
        const json = safeJsonParse(await safeText(res))
        const content = json ? extractContentFromChatCompletionResponse(json) : null
        if (content === null) {
          throw new ParseErrorBackendError(
            'Could not parse sidecar response as chat completion JSON'
          )
        }
        return content
      }

      return await this.readSSEStream(res)
    } finally {
      clearTimeout(timer)
    }
  }

  private async readSSEStream(res: Response): Promise<string> {
    const reader = res.body!.getReader()
    const decoder = new TextDecoder()
    let buffered = ''
    let full = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffered += decoder.decode(value, { stream: true })

      const { events, remainder } = parseSSEBuffer(buffered)
      buffered = remainder

      for (const evt of events) {
        if (isStreamDone(evt.data)) continue
        const json = safeJsonParse(evt.data)
        if (json === null) continue // malformed chunk - skip, don't fail the whole stream
        const delta = extractDeltaFromChatCompletionChunk(json)
        if (delta) full += delta
      }
    }

    return full
  }
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text()
  } catch {
    return ''
  }
}

class SidecarUnreachableError extends Error {}
class RequestFailedError extends Error {}
class TimeoutBackendError extends Error {}
class ParseErrorBackendError extends Error {}

function toBackendError(err: unknown): BackendError {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof SidecarUnreachableError) return { code: 'sidecar_unreachable', message }
  if (err instanceof TimeoutBackendError) return { code: 'timeout', message }
  if (err instanceof ParseErrorBackendError) return { code: 'parse_error', message }
  if (err instanceof RequestFailedError) return { code: 'request_failed', message }
  return { code: 'unknown', message }
}
