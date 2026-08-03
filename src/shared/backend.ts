/**
 * The InferenceBackend contract.
 *
 * This is the single seam between the app and whatever is actually doing
 * speech recognition / text generation. Satisfied by `LitertBackend`
 * (src/main/backend/litertBackend.ts), which spawns Google LiteRT-LM running
 * Gemma as a subprocess sidecar, talks to it over HTTP, and adapts its output
 * to this same shape - or by `UnavailableBackend`
 * (src/main/backend/backendController.ts) as an error-state placeholder
 * whenever that failed to start.
 *
 * The interface only ever runs in the Electron *main* process. The
 * renderer never talks to it directly - it goes through the typed IPC
 * bridge exposed on `window.api` by the preload script. See
 * src/main/ipc/*.ts for the IPC plumbing and src/preload/index.ts for the
 * renderer-facing surface.
 */

import type { Accelerator } from './types'

/** A single 16-bit PCM audio chunk, mono, 16kHz. */
export type AudioChunk = Int16Array

/**
 * Wire format used to carry an audio chunk across the renderer -> main IPC
 * boundary (ArrayBuffers survive structured cloning unambiguously; re-typing
 * a bare TypedArray after the hop is not guaranteed, so we tag it as a plain
 * ArrayBuffer instead). Always raw PCM16 from the AudioWorklet capture
 * pipeline - see useAudioCapture.ts, which fails visibly rather than falling
 * back to a different format if that pipeline is unavailable.
 */
export interface AudioChunkPayload {
  buffer: ArrayBuffer
  sampleRate: number
}

export type TransformMode = 'keypoints' | 'formal' | 'short' | 'long'

export interface StartSessionOptions {
  /** Sample rate of the PCM audio that will be pushed via pushAudio. */
  sampleRate?: number
  /** BCP-47ish language hint, e.g. "en-US". Optional, backend may ignore. */
  language?: string
  /** Custom vocabulary / proper nouns the recognizer should bias towards. */
  vocabulary?: string[]
}

/**
 * A live speech-to-text + text-processing backend.
 *
 * Lifecycle for a single dictation:
 *   1. `startSession(opts)` -> sessionId
 *   2. `pushAudio(sessionId, chunk)` repeatedly as audio arrives from the mic
 *      (partial transcripts stream out via `onPartialTranscript`)
 *   3. `endSession(sessionId)` -> final raw transcript
 *   4. `cleanup(rawTranscript)` -> polished transcript (fixes casing, strips
 *      filler words like "um"/"uh")
 *   5. optionally `transform(text, mode)` any number of times to re-derive
 *      Key Points / Formal / Short / Long versions
 *   6. optionally `voiceEdit(text, command)` to apply a spoken edit command
 *      such as "delete the last sentence" or "replace foo with bar"
 */
/**
 * Backend connectivity state, surfaced to the renderer as a small status
 * pill in the app header. The LiteRT-LM sidecar backend moves through
 * starting -> ready, or -> error if the sidecar process fails to spawn,
 * never answers, or dies mid-session.
 */
export type BackendStatusState = 'starting' | 'ready' | 'error'

export interface BackendStatus {
  state: BackendStatusState
  /**
   * Short, user-facing reason, set when state is 'error' (or transiently
   * while retrying). A few words - this is rendered inline on the Dictate
   * screen beside a disabled record button, where the only question worth
   * answering is "why can't I record". Engine diagnostics belong in
   * `detail`, not here: a paragraph about import failures or sidecar exit
   * codes is noise to someone who just needs to know a model isn't loaded.
   */
  message?: string
  /**
   * The underlying failure behind `message` - an engine stderr tail, a
   * failed import, a sidecar that exited. Written to the log and offered as
   * the status pill's hover title, never rendered inline.
   */
  detail?: string
  /**
   * The accelerator a managed sidecar's engine actually ended up running
   * on, once known - parsed from `serve_gpu.py`'s `BLURT_EFFECTIVE_BACKEND`
   * stdout marker (see that file and `Sidecar`/`BackendController`).
   * Undefined until observed, or when there's nothing to observe (mock
   * backend, 'external' sidecar mode). Never assume this matches the
   * requested `SidecarSettings.accelerator` - that's exactly the gap this
   * field exists to close (GPU can be requested but silently fall back to
   * CPU; this is the truth, not the request).
   */
  effectiveAccelerator?: Accelerator
}

/**
 * A typed error surfaced out-of-band (not as a rejected Promise) for
 * failures that happen during a live session - e.g. a periodic partial
 * transcription request failing while the user is still recording, where
 * there's no Promise for the failure to reject. Emitted via the optional
 * `onError` hook some backends (the LiteRT-LM one) implement in addition to
 * the base `InferenceBackend` contract.
 */
export interface BackendError {
  code:
    | 'sidecar_unreachable'
    | 'request_failed'
    | 'timeout'
    | 'parse_error'
    | 'unknown'
    /** The accumulated audio buffer for a partial tick or the final session was empty/near-silent - skipped the model call rather than risk a hallucinated transcript. */
    | 'no_audio'
  message: string
}

/**
 * Optional extra surface a backend may implement alongside
 * `InferenceBackend` to report out-of-band session errors. Checked with an
 * `in` guard at the IPC wiring layer (`src/main/ipc/backendIpc.ts`) so not
 * every `InferenceBackend` implementation is required to implement it.
 */
export interface BackendErrorSource {
  onError(listener: (sessionId: string, error: BackendError) => void): () => void
}

export interface InferenceBackend {
  /** Begin a new dictation session. Returns an opaque session id. */
  startSession(opts?: StartSessionOptions): Promise<string>

  /** Feed the next chunk of captured microphone audio for a session. */
  pushAudio(sessionId: string, chunk: AudioChunk): void

  /** Finish a session and resolve with the final raw transcript. */
  endSession(sessionId: string): Promise<string>

  /** Subscribe to streaming partial-transcript updates. Returns an unsubscribe fn. */
  onPartialTranscript(listener: (sessionId: string, text: string) => void): () => void

  /**
   * Polish a raw transcript: strip filler words, fix capitalization/punctuation.
   * If `operationId` is given, incremental progress is emitted via
   * `onTextStreamProgress` (keyed by that id) as the rewrite streams in -
   * see that method's doc comment for why an id rather than the session id.
   */
  cleanup(text: string, operationId?: string): Promise<string>

  /** Re-derive the text in a particular style. Streams progress the same way as `cleanup` when `operationId` is given. */
  transform(text: string, mode: TransformMode, operationId?: string): Promise<string>

  /** Apply a free-form spoken/typed edit command to the text. Streams progress the same way as `cleanup` when `operationId` is given. */
  voiceEdit(text: string, command: string, operationId?: string): Promise<string>

  /**
   * Subscribe to incremental text for an in-flight `cleanup`/`transform`/
   * `voiceEdit` call that was started with an `operationId`. Unlike
   * `onPartialTranscript` (scoped to a dictation session that already
   * exists) these calls have no natural id of their own, so the caller
   * mints one and both sides key off it. Never fires for calls made without
   * an `operationId`. Returns an unsubscribe fn.
   */
  onTextStreamProgress(listener: (operationId: string, text: string) => void): () => void
}
