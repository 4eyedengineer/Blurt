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
  sliceTrailingWindow,
  stripModelPreamble,
  type ChatCompletionRequestBody
} from './litertWire'
import { shouldLaunchPartialTick } from './partialTickScheduler'
import { ThrottledTextEmitter } from './streamThrottle'
import { stitchTranscript } from './transcriptStitcher'
import { log } from '../log'

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
/**
 * Bound on how much trailing audio a *partial* tick re-transcribes (see
 * `runPartialTranscription`'s window/commit logic), instead of the whole
 * session buffer. Sized against measured CPU throughput numbers: a ~4s
 * window keeps a tick's cost under the `DEFAULT_PARTIAL_INTERVAL_MS` cadence
 * indefinitely, regardless of how long the session has been running - the
 * fix for the "unbounded per-tick cost" finding. `endSession`'s final pass is
 * unaffected - it still
 * re-transcribes the *entire* buffer once, for accuracy (see its doc
 * comment).
 */
export const DEFAULT_PARTIAL_WINDOW_MS = 4000
/**
 * How much already-committed audio a partial tick's window reaches back
 * into, so a word cut off right at the committed boundary gets a full
 * second chance to be heard whole. `stitchTranscript` (transcriptStitcher.ts)
 * then dedupes the resulting repeated words at the seam.
 */
export const DEFAULT_PARTIAL_WINDOW_OVERLAP_MS = 800
/**
 * Extra ms of audio kept in `LitertSession.recentChunks` beyond
 * `partialWindowMs + partialWindowOverlapMs`, so normal ms-rounding/jitter
 * never prunes audio a tick's window still needs before the next push.
 */
const RECENT_CHUNKS_PRUNE_SLACK_MS = 500
/**
 * Minimum real-world ms required between a partial tick completing and the
 * next one launching - the "spiral guard" from the divergent-spiral finding:
 * without this, `msSinceLastPartial` (which keeps accruing new-audio ms
 * while a tick is in flight, by design - see `shouldLaunchPartialTick`'s doc
 * comment) is often already over threshold the instant a slow tick
 * completes, so the next tick used to launch immediately, back-to-back, with
 * no breathing room. Rolling windows (above) already bound each tick's own
 * cost, but this still matters on CPU-only hardware where a tick can take
 * longer than the interval - it makes such hardware degrade to a slower,
 * stable cadence instead of pegging the CPU with zero-gap requests.
 */
export const DEFAULT_MIN_PARTIAL_IDLE_GAP_MS = 300
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
const DEBUG_AUDIO_ENV_VAR = 'BLURT_DEBUG_AUDIO'

/**
 * Whether a piece of text is nothing at all, for the purposes of "is there
 * anything here to rewrite".
 *
 * This tiny predicate guards a real, user-visible data-integrity bug. The
 * cleanup/transform/voiceEdit prompts all mean "rewrite the user's text",
 * and a generative model handed an *empty* user message under that
 * instruction does not return an empty string - it writes a plausible
 * example of the thing it was asked to clean up. Observed verbatim in a
 * real user's history.json: two entries with `rawTranscript: ""` (the
 * transcription pass had correctly reported no speech) and
 * `cleanedText: "I want to go to the store."` - a sentence nobody ever
 * said, invented downstream, copied to the clipboard, and filed into
 * history as if it were a dictation.
 *
 * So the empty transcript was never the failure. It was the *correct
 * answer*, destroyed one step later. Nothing about that is fixable by
 * tuning audio thresholds, and no prompt wording reliably fixes it either
 * (the transcription prompt's own "output nothing if silent" instruction
 * worked exactly as intended - it's the cleanup pass that has no way to
 * distinguish "nothing was said" from "clean up this empty text"). The only
 * robust fix is to never make the call.
 */
function isBlank(text: string): boolean {
  return text.trim().length === 0
}

interface LitertSession {
  id: string
  sampleRate: number
  /**
   * The FULL archive of every chunk pushed this session, in order - never
   * pruned. Only read from in `endSession`'s longer-session path (one final
   * full-buffer transcription for accuracy) and the debug-WAV dump; partial
   * ticks read from `recentChunks` instead so their cost never scales with
   * how long the session has been running.
   */
  chunks: Int16Array[]
  /**
   * Rolling buffer holding only the trailing `partialWindowMs +
   * partialWindowOverlapMs + slack` ms of audio - kept in sync with
   * `chunks` (same chunks pushed to both) but pruned from the front on every
   * push (see `pruneRecentChunks`). Lets a partial tick slice out its bounded
   * window in time proportional to the window size, not total session
   * length.
   */
  recentChunks: Int16Array[]
  /** Total ms of audio currently represented by `recentChunks` (sum of its chunks' durations). */
  recentChunksMs: number
  /** Cumulative ms of ALL audio ever pushed this session - monotonic, never reset; the audio-time position `chunks`/`recentChunks` currently end at. */
  totalAudioMs: number
  /**
   * Text committed from earlier rolling windows - fixed, never re-decoded
   * again. Empty until the session's audio first exceeds one window's worth
   * (`committedAudioMs` stays 0 until then) - see `runPartialTranscription`.
   */
  committedText: string
  /**
   * Audio-ms boundary up to which `committedText` is considered fixed. 0
   * means "no commit has ever happened" - i.e. every partial tick so far has
   * had a window starting at sample 0, so it covered the *whole* buffer, the
   * same as the pre-rolling-window design (this is what lets `endSession`
   * reuse an in-flight tick's result for short sessions - see its doc
   * comment).
   */
  committedAudioMs: number
  /**
   * The full merged (`committedText` + that tick's stitched window) display
   * text produced by the most recently *completed* tick - the commit
   * candidate promoted into `committedText` (with `lastTickAudioMs`
   * promoted into `committedAudioMs`) the next time a tick's window would
   * otherwise have to reach further back than `committedAudioMs` covers.
   */
  lastTickMergedText: string
  /** `totalAudioMs` as of the most recently completed tick's dispatch - see `lastTickMergedText`. */
  lastTickAudioMs: number
  /**
   * Wall-clock time (per the injectable clock) the most recently completed
   * tick finished, or null if none ever has - spiral-guard idle-gap
   * enforcement, see `shouldLaunchPartialTick`.
   */
  lastPartialCompletionAtMs: number | null
  msSinceLastPartial: number
  hasAudio: boolean
  partialInFlight: boolean
  /**
   * The in-flight mid-recording partial tick's own streaming promise, if
   * any - resolves to the tick's full merged (`committedText` + stitched
   * window) display text, i.e. exactly what a fresh final transcription
   * would be expected to show. `endSession` awaits and reuses this directly
   * instead of discarding it and paying for a second full re-transcription
   * of the same audio when nothing changed since it started (see
   * `endSession`'s doc comment) - but only for short sessions
   * (`committedAudioMs === 0`); once a session has grown past one window,
   * `endSession` always pays for one accurate full-buffer pass instead (see
   * its doc comment for why). Cleared whenever no tick is in flight.
   */
  partialPromise: Promise<string> | null
  /**
   * `chunks.length` at the moment the in-flight tick above took its
   * buffer snapshot - lets `endSession` detect whether *more* audio arrived
   * after that snapshot (in which case the tick's result is stale and a
   * fresh final re-transcription covering the full buffer is still needed).
   */
  partialSnapshotChunkCount: number
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
  /** Bounds a partial tick's re-transcribed audio window - see `DEFAULT_PARTIAL_WINDOW_MS`. Mainly a test seam. */
  partialWindowMs?: number
  /** Overlap into already-committed audio a partial tick's window includes - see `DEFAULT_PARTIAL_WINDOW_OVERLAP_MS`. Mainly a test seam. */
  partialWindowOverlapMs?: number
  /** Minimum idle gap enforced between a tick completing and the next launching - see `DEFAULT_MIN_PARTIAL_IDLE_GAP_MS`. Mainly a test seam. */
  minPartialIdleGapMs?: number
  requestTimeoutMs?: number
  /** How often (ms) streamed text is allowed to reach the renderer - see ThrottledTextEmitter. Mainly a test seam. */
  streamThrottleMs?: number
  /** Injectable wall clock (ms since epoch), for deterministic spiral-guard tests. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Directory each session's final accumulated WAV is written to, as
   * `session-<n>.wav`, when the BLURT_DEBUG_AUDIO=1 env var is set.
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
  private readonly partialWindowMs: number
  private readonly partialWindowOverlapMs: number
  private readonly minPartialIdleGapMs: number
  private readonly requestTimeoutMs: number
  private readonly streamThrottleMs: number
  private readonly now: () => number
  /**
   * The real `litert-lm serve` is a plain `http.server.HTTPServer` (not
   * `ThreadingHTTPServer`) - verified empirically that a second concurrent
   * request just blocks on the TCP accept until the first fully completes.
   * Every outgoing request
   * (transcription, cleanup, transform, voice-edit, warmup) is funneled
   * through this one promise chain so we never have two fetches in flight
   * at once, each racing its own timeout clock while actually queued
   * server-side.
   */
  private requestQueue: Promise<void> = Promise.resolve()
  /** Incremented per session that gets debug-dumped, to name session-<n>.wav files. Only touched when BLURT_DEBUG_AUDIO=1. */
  private debugSessionCounter = 0

  constructor(private readonly options: LitertBackendOptions) {
    this.partialIntervalMs = options.partialIntervalMs ?? DEFAULT_PARTIAL_INTERVAL_MS
    this.partialWindowMs = options.partialWindowMs ?? DEFAULT_PARTIAL_WINDOW_MS
    this.partialWindowOverlapMs =
      options.partialWindowOverlapMs ?? DEFAULT_PARTIAL_WINDOW_OVERLAP_MS
    this.minPartialIdleGapMs = options.minPartialIdleGapMs ?? DEFAULT_MIN_PARTIAL_IDLE_GAP_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.streamThrottleMs = options.streamThrottleMs ?? DEFAULT_STREAM_THROTTLE_MS
    this.now = options.now ?? Date.now
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
   * queue as real requests, to force the sidecar's lazy model load (measured
   * at ~5.6s cold vs ~1.4s warm for E2B on CPU) to happen right after the
   * sidecar comes up instead of blocking the user's first real utterance.
   * Failures are swallowed - a
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
      recentChunks: [],
      recentChunksMs: 0,
      totalAudioMs: 0,
      committedText: '',
      committedAudioMs: 0,
      lastTickMergedText: '',
      lastTickAudioMs: 0,
      lastPartialCompletionAtMs: null,
      msSinceLastPartial: 0,
      hasAudio: false,
      partialInFlight: false,
      partialPromise: null,
      partialSnapshotChunkCount: 0,
      lastTranscript: '',
      ended: false,
      vocabulary: opts?.vocabulary ?? this.options.getVocabulary?.()
    })
    return id
  }

  pushAudio(sessionId: string, chunk: AudioChunk): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) return

    const chunkMs = (chunk.length / session.sampleRate) * 1000
    session.chunks.push(chunk)
    session.recentChunks.push(chunk)
    session.recentChunksMs += chunkMs
    this.pruneRecentChunks(session)
    session.totalAudioMs += chunkMs
    session.hasAudio = true
    session.msSinceLastPartial += chunkMs

    if (
      shouldLaunchPartialTick(
        {
          msSinceSnapshot: session.msSinceLastPartial,
          tickInFlight: session.partialInFlight,
          lastCompletionAtMs: session.lastPartialCompletionAtMs
        },
        {
          intervalMs: this.partialIntervalMs,
          minIdleGapMs: this.minPartialIdleGapMs,
          nowMs: this.now()
        }
      )
    ) {
      session.msSinceLastPartial = 0
      void this.runPartialTranscription(session)
    }
  }

  /**
   * Drops chunks off the front of `session.recentChunks` once they've fallen
   * further back than any partial tick's window could ever need (bounded by
   * `partialWindowMs + partialWindowOverlapMs`, plus a slack margin for
   * ms-rounding) - keeps `recentChunks` a small, session-length-independent
   * rolling buffer. `session.chunks` (the full archive) is untouched.
   */
  private pruneRecentChunks(session: LitertSession): void {
    const keepMs = this.partialWindowMs + this.partialWindowOverlapMs + RECENT_CHUNKS_PRUNE_SLACK_MS
    while (session.recentChunks.length > 1) {
      const front = session.recentChunks[0]
      const frontMs = (front.length / session.sampleRate) * 1000
      if (session.recentChunksMs - frontMs < keepMs) break
      session.recentChunks.shift()
      session.recentChunksMs -= frontMs
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

  /**
   * Fires one mid-recording re-transcription tick. Only re-transcribes a
   * bounded trailing *window* of audio (not the whole session, see
   * `DEFAULT_PARTIAL_WINDOW_MS`) - the direct fix for the "per-tick cost
   * grows with session length, falls behind the tick interval after ~4s on
   * CPU" finding.
   *
   * Window/commit bookkeeping: each tick first checks whether a *plain*
   * trailing window (ending "now", `partialWindowMs` long) would start
   * further forward than `session.committedAudioMs` - i.e. whether the next
   * window would no longer reach back far enough to still cover everything
   * `committedText` represents. If so, the previous tick's merged output
   * (`lastTickMergedText`/`lastTickAudioMs`) is promoted into
   * `committedText`/`committedAudioMs` right now, so it's never lost. The
   * window actually sent to the model then starts `partialWindowOverlapMs`
   * before that (possibly just-updated) commit boundary - giving a word cut
   * off right at the boundary a full second chance to be heard whole - but
   * never further back than the plain trailing window would allow, which is
   * what keeps every tick's cost bounded regardless of how far behind
   * committing has fallen (e.g. after a slow/delayed tick).
   *
   * Each streamed chunk is `stitchTranscript`'d against `committedText`
   * (transcriptStitcher.ts) before being shown, so the displayed text is
   * always the full transcript-so-far, not just the current window's -
   * exactly like the pre-rolling-window design from the renderer's point of
   * view. Streams out over the same 'partial' event throughout - including
   * after `endSession` has already been called for this session (no
   * `!session.ended` guard here, deliberately: see `endSession`'s doc
   * comment for why silencing this stream used to create a long visible
   * "frozen" gap right when recording stops, which is exactly when the user
   * is watching most closely).
   */
  private async runPartialTranscription(session: LitertSession): Promise<void> {
    session.partialInFlight = true
    session.partialSnapshotChunkCount = session.chunks.length
    const tickAudioMs = session.totalAudioMs

    try {
      const plainWindowStartMs = Math.max(0, tickAudioMs - this.partialWindowMs)
      if (plainWindowStartMs > session.committedAudioMs) {
        session.committedText = session.lastTickMergedText || session.committedText
        session.committedAudioMs = session.lastTickAudioMs
      }

      const windowStartMs = Math.max(
        plainWindowStartMs,
        Math.max(0, session.committedAudioMs - this.partialWindowOverlapMs)
      )
      const recentChunksStartMs = tickAudioMs - session.recentChunksMs
      const samples = sliceTrailingWindow(
        session.recentChunks,
        recentChunksStartMs,
        session.sampleRate,
        windowStartMs,
        tickAudioMs
      )

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

      const committedTextAtStart = session.committedText
      const rawPromise = this.transcribeSamplesStreaming(session, samples, (windowText) => {
        const merged = stitchTranscript(committedTextAtStart, windowText)
        session.lastTranscript = merged
        this.emitter.emit('partial', session.id, merged)
      })
      const mergedPromise = rawPromise.then((windowText) =>
        stitchTranscript(committedTextAtStart, windowText)
      )
      session.partialPromise = mergedPromise
      const finalMerged = await mergedPromise
      session.lastTickMergedText = finalMerged
      session.lastTickAudioMs = tickAudioMs
    } catch (err) {
      this.emitError(session.id, err)
    } finally {
      session.partialInFlight = false
      session.partialPromise = null
      session.lastPartialCompletionAtMs = this.now()
    }
  }

  private isSilentBuffer(samples: Int16Array): boolean {
    return samples.length === 0 || computeRms(samples) < SILENCE_RMS_THRESHOLD
  }

  /**
   * Best-effort: writes the session's fully accumulated PCM as a WAV file
   * to `debugAudioDir`, gated on BLURT_DEBUG_AUDIO=1. Lets a human check
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
      log.info(
        `litertBackend: ${DEBUG_AUDIO_ENV_VAR} wrote ${filePath} ` +
          `(${samples.length} samples, rms=${computeRms(samples).toFixed(1)})`
      )
    } catch (err) {
      log.warn(
        `litertBackend: ${DEBUG_AUDIO_ENV_VAR} failed to write debug WAV: ` +
          `${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  async endSession(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) return ''
    session.ended = true
    this.sessions.delete(sessionId)

    // The two ways a session can end without the model ever being called
    // look identical from outside (an empty transcript) but mean completely
    // different things, so they are logged apart. This one: not a single
    // PCM chunk was ever pushed, so capture never delivered anything.
    if (!session.hasAudio) {
      log.warn(`litertBackend: session ${sessionId} ended with no audio at all (no chunks pushed)`)
      return session.lastTranscript
    }

    // If a mid-recording partial tick is still in flight *and* no new audio
    // arrived after it took its buffer snapshot, its result covers exactly
    // the same audio a fresh final re-transcription would - so just await
    // and reuse it instead of discarding it and paying for a second full
    // round trip over the identical buffer. This is ONLY equivalent to a
    // full-buffer final pass while `committedAudioMs === 0` - i.e. no
    // rolling-window commit has ever happened yet, meaning every tick so far
    // (including the in-flight one) had its window start at sample 0 and so
    // covered the *whole* buffer, exactly like the pre-rolling-window
    // design. Once a session has grown past one window's worth of audio and
    // committing has kicked in, an in-flight tick's result is only the
    // *current window's* stitched text - reusing it would mean skipping the
    // "one accurate full-buffer final pass" this method promises for longer
    // sessions (see the full-pass branch below), so this optimization is
    // deliberately restricted to short sessions only.
    //
    // This used to always discard the in-flight tick (via a `!session.ended`
    // guard on its stream callback, removed) and unconditionally re-run a
    // brand new transcription from scratch after it finished. For a short
    // recording - very common, e.g. anyone's first "does this work?" test
    // utterance - there is *often exactly one* tick in flight when the user
    // stops, so 100% of the streaming window got thrown away: the renderer
    // saw nothing at all from the moment recording stopped until this
    // second, fully-redundant request completed, doubling real-world
    // latency and making the live-streaming feature look completely broken
    // even though the sidecar and the throttled-emit plumbing were working
    // correctly the whole time (see litertBackend's onPartialTranscript
    // proof harnesses referenced in the fix's commit).
    if (
      session.committedAudioMs === 0 &&
      session.partialInFlight &&
      session.partialPromise &&
      session.partialSnapshotChunkCount === session.chunks.length
    ) {
      void this.maybeDumpDebugWav(concatInt16(session.chunks), session.sampleRate)
      try {
        return await session.partialPromise
      } catch (err) {
        this.emitError(sessionId, err)
        return session.lastTranscript
      }
    }

    // Otherwise (session has grown past one window so a full pass is needed
    // for accuracy regardless, no tick in flight, or more audio arrived
    // after the last tick's snapshot so its result is stale) - serialize
    // with any still-in-flight partial rather than racing it, both would hit
    // the same sidecar session-less endpoint concurrently otherwise. This is
    // the ONE O(session length) full-buffer pass a longer session still
    // pays, deliberately, for final accuracy - but only once, not doubled on
    // top of the (now bounded-cost) partial ticks. Bounded by
    // requestTimeoutMs so a stuck partial can't
    // hang endSession forever.
    const deadline = Date.now() + this.requestTimeoutMs
    while (session.partialInFlight && Date.now() < deadline) {
      await sleep(50)
    }

    const samples = concatInt16(session.chunks)
    void this.maybeDumpDebugWav(samples, session.sampleRate)

    // ...and this one: audio arrived, but every sample of it was at or near
    // digital silence. Logging the measured RMS alongside the threshold is
    // what makes a "nothing happened" report diagnosable at all: an rms of
    // ~0 means the capture device is delivering silence (muted, or the
    // wrong input selected), while an rms comfortably above the threshold
    // would mean this guard is the thing that is wrong.
    if (this.isSilentBuffer(samples)) {
      log.warn(
        `litertBackend: session ${sessionId} buffer judged silent - skipping the model call ` +
          `(samples=${samples.length}, rms=${computeRms(samples).toFixed(1)}, threshold=${SILENCE_RMS_THRESHOLD})`
      )
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
    if (isBlank(text)) return this.refuseBlankRewrite('cleanup')
    const request = buildCleanupRequest({
      model: this.options.modelId,
      text,
      vocabulary: this.options.getVocabulary?.()
    })
    return this.runStreamingRequest(request, operationId)
  }

  async transform(text: string, mode: TransformMode, operationId?: string): Promise<string> {
    if (isBlank(text)) return this.refuseBlankRewrite(`transform:${mode}`)
    const request = buildTransformRequest({ model: this.options.modelId, text, mode })
    return this.runStreamingRequest(request, operationId)
  }

  async voiceEdit(text: string, command: string, operationId?: string): Promise<string> {
    if (isBlank(text)) return this.refuseBlankRewrite('voiceEdit')
    const request = buildVoiceEditRequest({ model: this.options.modelId, text, command })
    return this.runStreamingRequest(request, operationId)
  }

  /**
   * The shared "there is nothing to rewrite" exit for cleanup/transform/
   * voiceEdit. Returns '' - the only honest rewrite of nothing - and logs,
   * because a blank reaching here means an upstream caller should have
   * stopped earlier (see the guards in useDictationSession/
   * useOverlayPushToTalk) and that is worth seeing in main.log.
   */
  private refuseBlankRewrite(operation: string): string {
    console.warn(
      `[LitertBackend] ${operation}: input was blank - returning '' without a model call`
    )
    return ''
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

function toBackendError(err: unknown): BackendError {
  const message = err instanceof Error ? err.message : String(err)
  if (err instanceof SidecarUnreachableError) return { code: 'sidecar_unreachable', message }
  if (err instanceof TimeoutBackendError) return { code: 'timeout', message }
  if (err instanceof ParseErrorBackendError) return { code: 'parse_error', message }
  if (err instanceof RequestFailedError) return { code: 'request_failed', message }
  if (err instanceof NoAudioError) return { code: 'no_audio', message }
  return { code: 'unknown', message }
}
