import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import { promises as fsPromises } from 'fs'
import path from 'path'
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
  buildWarmupRequest,
  computeRms,
  concatInt16,
  extractContentFromChatCompletionResponse,
  extractDeltaFromChatCompletionChunk,
  isStreamDone,
  parseSSEBuffer,
  pcm16ToWavBase64,
  pcm16ToWavBuffer,
  safeJsonParse,
  stripModelPreamble,
  type ChatCompletionRequestBody
} from './litertWire'
import { ThrottledTextEmitter } from './streamThrottle'

/**
 * How often (ms of *new* audio, not wall-clock time) to fire a partial
 * re-transcription tick. Deliberately short (down from an earlier 3000ms) -
 * each tick now streams its result in via SSE (see `runPartialTranscription`)
 * rather than blocking on the whole re-transcription, so a snappier tick
 * rate mostly just means the *next* re-transcription of the growing buffer
 * starts sooner; `partialInFlight` still skips a tick outright if the
 * previous one hasn't finished, so this self-throttles on slower hardware.
 */
const DEFAULT_PARTIAL_INTERVAL_MS = 1500
/** How often (ms) streamed partial/cleanup/transform/voiceEdit text is allowed to reach the renderer - see ThrottledTextEmitter. */
const DEFAULT_STREAM_THROTTLE_MS = 100
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const DEFAULT_SAMPLE_RATE = 16000
/**
 * RMS (raw int16 units, 0..~32767) below which an accumulated audio buffer
 * is treated as empty/silent rather than sent to the model. Deliberately
 * conservative - true digital silence (a dropped/broken capture path) sits
 * at or near 0; even a quiet room with a live mic reads well above this.
 */
const SILENCE_RMS_THRESHOLD = 40
/** Env var gate for LitertBackend.maybeDumpDebugWav - see README/task notes. */
const DEBUG_AUDIO_ENV_VAR = 'ELOQUENT_DEBUG_AUDIO'

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
  /** Set once we've emitted the 'unsupported_audio' warning for this session, so a MediaRecorder-fallback recording doesn't spam it on every dropped chunk. */
  fallbackWarned: boolean
}

export interface LitertBackendOptions {
  /** Resolved lazily on every request so a sidecar restart/port change is picked up transparently. */
  getBaseUrl: () => string
  /** Sent as the `model` field on every request; the sidecar has one model loaded regardless. */
  modelId: string
  getVocabulary?: () => string[]
  partialIntervalMs?: number
  requestTimeoutMs?: number
  /** How often (ms) streamed text is allowed to reach the renderer - see ThrottledTextEmitter. Mainly a test seam. */
  streamThrottleMs?: number
  /**
   * Directory each session's final accumulated WAV is written to, as
   * `session-<n>.wav`, when the ELOQUENT_DEBUG_AUDIO=1 env var is set.
   * No-op (and no directory created) if unset or if the env var isn't '1'.
   */
  debugAudioDir?: string
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
  private readonly streamThrottleMs: number
  /**
   * The real `litert-lm serve` is a plain `http.server.HTTPServer` (not
   * `ThreadingHTTPServer`) - verified empirically that a second concurrent
   * request just blocks on the TCP accept until the first fully completes
   * (scratchpad/sidecar-verification.md gotcha 2). Every outgoing request
   * (transcription, cleanup, transform, voice-edit, warmup) is funneled
   * through this one promise chain so we never have two fetches in flight
   * at once, each racing its own timeout clock while actually queued
   * server-side.
   */
  private requestQueue: Promise<void> = Promise.resolve()
  /** Incremented per session that gets debug-dumped, to name session-<n>.wav files. Only touched when ELOQUENT_DEBUG_AUDIO=1. */
  private debugSessionCounter = 0

  constructor(private readonly options: LitertBackendOptions) {
    this.partialIntervalMs = options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.streamThrottleMs = options.streamThrottleMs ?? DEFAULT_STREAM_THROTTLE_MS
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.requestQueue.then(fn, fn)
    this.requestQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  /**
   * Best-effort: sends a throwaway minimal request through the same serial
   * queue as real requests, to force the sidecar's lazy model load (see
   * scratchpad/sidecar-verification.md §3/gotcha 5 - ~5.6s cold vs ~1.4s warm
   * for E2B on CPU) to happen right after the sidecar comes up instead of
   * blocking the user's first real utterance. Failures are swallowed - a
   * failed warmup just means the first real request pays the cold-start
   * cost instead of this one.
   */
  async warmup(): Promise<void> {
    try {
      await this.enqueue(() => this.chatCompletion(buildWarmupRequest(this.options.modelId)))
    } catch {
      // Best-effort only - see doc comment above.
    }
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
      vocabulary: opts?.vocabulary ?? this.options.getVocabulary?.(),
      fallbackWarned: false
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
      // README "Known deviations". Surface it once per session rather than
      // silently swallowing every chunk - otherwise the user just sees
      // dead air with no indication their audio was never usable.
      if (!session.fallbackWarned) {
        session.fallbackWarned = true
        this.emitError(
          sessionId,
          new UnsupportedAudioFormatError(
            'Microphone audio arrived as compressed webm (AudioWorklet fallback) - this backend can only use raw PCM, so no audio is being sent to the model.'
          )
        )
      }
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

  /**
   * Re-transcribes the whole accumulated buffer so far and streams the
   * result out via `onStreamText` as it arrives (throttled - see
   * ThrottledTextEmitter) instead of waiting for the full completion. Each
   * call streams the *entire* current buffer's transcript from scratch, so
   * every call to `onStreamText` should be treated as replacing whatever was
   * shown before, not appending to it - that's inherent to re-transcribing
   * the whole buffer on every tick rather than doing true incremental ASR.
   * Shared by `runPartialTranscription` (mid-recording ticks) and
   * `endSession` (the final tick), which differ only in what they do with
   * each streamed chunk and the final value.
   */
  private async transcribeSamplesStreaming(
    session: LitertSession,
    samples: Int16Array,
    onStreamText: (text: string) => void
  ): Promise<string> {
    const wavBase64 = pcm16ToWavBase64(samples, session.sampleRate)
    const request = buildTranscriptionRequest({
      model: this.options.modelId,
      wavBase64,
      vocabulary: session.vocabulary
    })
    const throttled = new ThrottledTextEmitter({
      intervalMs: this.streamThrottleMs,
      emit: onStreamText
    })
    const raw = await this.enqueue(() =>
      this.chatCompletion(request, (accumulated) => throttled.push(stripModelPreamble(accumulated)))
    )
    const text = stripModelPreamble(raw)
    // Guarantees the exact final (preamble-stripped, fully-settled) value is
    // delivered synchronously, even if the last streamed chunk differed
    // slightly (e.g. a preamble line only becomes strippable once the whole
    // first line has arrived) or no chunk streamed at all (non-SSE fallback).
    throttled.flush(text)
    return text
  }

  private async runPartialTranscription(session: LitertSession): Promise<void> {
    session.partialInFlight = true
    try {
      const samples = concatInt16(session.chunks)
      if (this.isSilentBuffer(samples)) {
        // Don't waste a model call (and risk a hallucinated "transcript")
        // on a buffer that's empty or near-silent - almost always means the
        // capture path isn't actually delivering mic audio (see
        // useAudioCapture / pcm-worklet-processor.js). Tell the renderer
        // instead of just going quiet.
        this.emitError(
          session.id,
          new NoAudioError('No audio detected - the microphone signal is silent.')
        )
        return
      }
      await this.transcribeSamplesStreaming(session, samples, (text) => {
        if (!session.ended) {
          session.lastTranscript = text
          this.emitter.emit('partial', session.id, text)
        }
      })
    } catch (err) {
      this.emitError(session.id, err)
    } finally {
      session.partialInFlight = false
    }
  }

  private isSilentBuffer(samples: Int16Array): boolean {
    return samples.length === 0 || computeRms(samples) < SILENCE_RMS_THRESHOLD
  }

  /**
   * Best-effort: writes the session's fully accumulated PCM as a WAV file
   * to `debugAudioDir`, gated on ELOQUENT_DEBUG_AUDIO=1. Lets a human check
   * exactly what audio the model was (or wasn't) asked to transcribe -
   * cheap enough to always compile in, and a no-op unless explicitly
   * enabled.
   */
  private async maybeDumpDebugWav(samples: Int16Array, sampleRate: number): Promise<void> {
    const dir = this.options.debugAudioDir
    if (process.env[DEBUG_AUDIO_ENV_VAR] !== '1' || !dir) return
    try {
      await fsPromises.mkdir(dir, { recursive: true })
      const n = ++this.debugSessionCounter
      const filePath = path.join(dir, `session-${n}.wav`)
      await fsPromises.writeFile(filePath, pcm16ToWavBuffer(samples, sampleRate))
      console.log(
        `[LitertBackend] ${DEBUG_AUDIO_ENV_VAR}: wrote ${filePath} ` +
          `(${samples.length} samples, rms=${computeRms(samples).toFixed(1)})`
      )
    } catch (err) {
      console.warn(`[LitertBackend] ${DEBUG_AUDIO_ENV_VAR}: failed to write debug WAV:`, err)
    }
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

    const samples = concatInt16(session.chunks)
    void this.maybeDumpDebugWav(samples, session.sampleRate)

    if (this.isSilentBuffer(samples)) {
      this.emitError(
        sessionId,
        new NoAudioError(
          'No audio detected - the microphone signal was silent for the entire recording.'
        )
      )
      return ''
    }

    try {
      // Streams the final transcription in the exact same way (and over the
      // same 'partial' event) as a mid-recording tick - the session is
      // already marked `ended` so this is unambiguously the last update the
      // renderer will see for it, rather than needing a separate IPC event
      // just for "the final one is streaming too".
      return await this.transcribeSamplesStreaming(session, samples, (text) => {
        session.lastTranscript = text
        this.emitter.emit('partial', session.id, text)
      })
    } catch (err) {
      this.emitError(sessionId, err)
      return session.lastTranscript
    }
  }

  onPartialTranscript(listener: (sessionId: string, text: string) => void): () => void {
    this.emitter.on('partial', listener)
    return () => this.emitter.off('partial', listener)
  }

  onTextStreamProgress(listener: (operationId: string, text: string) => void): () => void {
    this.emitter.on('text-stream-progress', listener)
    return () => this.emitter.off('text-stream-progress', listener)
  }

  onError(listener: (sessionId: string, error: BackendError) => void): () => void {
    this.emitter.on('session-error', listener)
    return () => this.emitter.off('session-error', listener)
  }

  private emitError(sessionId: string, err: unknown): void {
    this.emitter.emit('session-error', sessionId, toBackendError(err))
  }

  async cleanup(text: string, operationId?: string): Promise<string> {
    const request = buildCleanupRequest({
      model: this.options.modelId,
      text,
      vocabulary: this.options.getVocabulary?.()
    })
    return this.runStreamingRequest(request, operationId)
  }

  async transform(text: string, mode: TransformMode, operationId?: string): Promise<string> {
    const request = buildTransformRequest({ model: this.options.modelId, text, mode })
    return this.runStreamingRequest(request, operationId)
  }

  async voiceEdit(text: string, command: string, operationId?: string): Promise<string> {
    const request = buildVoiceEditRequest({ model: this.options.modelId, text, command })
    return this.runStreamingRequest(request, operationId)
  }

  /**
   * Runs a chat-completions request to completion, optionally streaming
   * throttled progress out via the 'text-stream-progress' event (see
   * `onTextStreamProgress`) as the response arrives - used by
   * cleanup/transform/voiceEdit, all of which share the same "rewrite this
   * text" shape. Skips the throttled emitter entirely when no
   * `operationId` is given (nothing is listening for it).
   */
  private async runStreamingRequest(
    request: ChatCompletionRequestBody,
    operationId?: string
  ): Promise<string> {
    if (!operationId) {
      const raw = await this.enqueue(() => this.chatCompletion(request))
      return stripModelPreamble(raw)
    }

    const throttled = new ThrottledTextEmitter({
      intervalMs: this.streamThrottleMs,
      emit: (text) => this.emitter.emit('text-stream-progress', operationId, text)
    })
    const raw = await this.enqueue(() =>
      this.chatCompletion(request, (accumulated) => throttled.push(stripModelPreamble(accumulated)))
    )
    const text = stripModelPreamble(raw)
    throttled.flush(text)
    return text
  }

  /**
   * Sends a chat-completions request and returns the full assistant reply.
   * Always requests `stream: true` (per the design's SSE-first approach)
   * but defensively falls back to parsing a plain JSON body if the server
   * doesn't actually stream (e.g. content-type isn't text/event-stream) -
   * see litertWire.ts's guards. `onProgress`, if given, is called with the
   * accumulated (not yet preamble-stripped) text after every SSE chunk -
   * a no-op when the server falls back to the non-streaming JSON path,
   * since there's nothing incremental to report there.
   */
  private async chatCompletion(
    body: ChatCompletionRequestBody,
    onProgress?: (accumulatedText: string) => void
  ): Promise<string> {
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

      return await this.readSSEStream(res, onProgress)
    } finally {
      clearTimeout(timer)
    }
  }

  private async readSSEStream(
    res: Response,
    onProgress?: (accumulatedText: string) => void
  ): Promise<string> {
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

      let changed = false
      for (const evt of events) {
        if (isStreamDone(evt.data)) continue
        const json = safeJsonParse(evt.data)
        if (json === null) continue // malformed chunk - skip, don't fail the whole stream
        const delta = extractDeltaFromChatCompletionChunk(json)
        if (delta) {
          full += delta
          changed = true
        }
      }
      if (changed) onProgress?.(full)
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
class NoAudioError extends Error {}
class UnsupportedAudioFormatError extends Error {}

function toBackendError(err: unknown): BackendError {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof SidecarUnreachableError) return { code: 'sidecar_unreachable', message }
  if (err instanceof TimeoutBackendError) return { code: 'timeout', message }
  if (err instanceof ParseErrorBackendError) return { code: 'parse_error', message }
  if (err instanceof RequestFailedError) return { code: 'request_failed', message }
  if (err instanceof NoAudioError) return { code: 'no_audio', message }
  if (err instanceof UnsupportedAudioFormatError) return { code: 'unsupported_audio', message }
  return { code: 'unknown', message }
}
