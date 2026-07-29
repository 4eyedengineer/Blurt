import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'
import type {
  AudioChunk,
  InferenceBackend,
  StartSessionOptions,
  TransformMode
} from '../../shared/backend'
import { pickRandomScript, FILLER_LOOP_WORDS } from './scripts'
import { applyVoiceEdit, cleanupText, transformText } from './textOps'

/** How much simulated audio (ms) must accumulate before the next word "arrives". */
const WORD_INTERVAL_MS = 380
/** Assumed sample rate for Int16 PCM chunks when the caller doesn't say otherwise. */
const DEFAULT_SAMPLE_RATE = 16000
/** Fallback duration estimate (ms) attributed to a single compressed-audio chunk (e.g. webm). */
const FALLBACK_CHUNK_MS = 250

const CLEANUP_DELAY_MS = 1000
const TRANSFORM_DELAY_MS = 600
const VOICE_EDIT_DELAY_MS = 300
/** How often (ms) a simulated streaming rewrite reveals its next word-step - see streamText. */
const STREAM_STEP_MS = 90

interface Session {
  id: string
  sampleRate: number
  scriptWords: string[]
  loopIndex: number
  wordIndex: number
  transcript: string
  audioMsAccumulated: number
  ended: boolean
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Fully-mocked implementation of InferenceBackend. Simulates a streaming
 * speech recognizer by "revealing" one word from a canned demo script for
 * every ~380ms of audio pushed to it (regardless of what's actually said,
 * since there's no real model here yet). This lets the full app - live
 * transcript, cleanup pass, transforms, voice edit - be exercised end to
 * end without the real LiteRT-LM/Gemma backend.
 */
export class MockBackend implements InferenceBackend {
  private sessions = new Map<string, Session>()
  private emitter = new EventEmitter()

  async startSession(opts?: StartSessionOptions): Promise<string> {
    const id = randomUUID()
    this.sessions.set(id, {
      id,
      sampleRate: opts?.sampleRate ?? DEFAULT_SAMPLE_RATE,
      scriptWords: pickRandomScript(),
      loopIndex: 0,
      wordIndex: 0,
      transcript: '',
      audioMsAccumulated: 0,
      ended: false
    })
    return id
  }

  pushAudio(sessionId: string, chunk: AudioChunk): void {
    const session = this.sessions.get(sessionId)
    if (!session || session.ended) return

    const durationMs =
      chunk instanceof Int16Array ? (chunk.length / session.sampleRate) * 1000 : FALLBACK_CHUNK_MS

    session.audioMsAccumulated += durationMs

    while (session.audioMsAccumulated >= WORD_INTERVAL_MS) {
      session.audioMsAccumulated -= WORD_INTERVAL_MS
      const nextWord = this.nextWord(session)
      session.transcript = session.transcript ? `${session.transcript} ${nextWord}` : nextWord
      this.emitter.emit('partial', session.id, session.transcript)
    }
  }

  private nextWord(session: Session): string {
    if (session.wordIndex < session.scriptWords.length) {
      return session.scriptWords[session.wordIndex++]
    }
    // Ran past the canned script (long recording) - loop generic filler
    // words so the demo keeps producing output indefinitely.
    const word = FILLER_LOOP_WORDS[session.loopIndex % FILLER_LOOP_WORDS.length]
    session.loopIndex++
    return word
  }

  async endSession(sessionId: string): Promise<string> {
    const session = this.sessions.get(sessionId)
    if (!session) return ''
    session.ended = true
    this.sessions.delete(sessionId)
    return session.transcript.trim()
  }

  onPartialTranscript(listener: (sessionId: string, text: string) => void): () => void {
    this.emitter.on('partial', listener)
    return () => this.emitter.off('partial', listener)
  }

  onTextStreamProgress(listener: (operationId: string, text: string) => void): () => void {
    this.emitter.on('text-stream-progress', listener)
    return () => this.emitter.off('text-stream-progress', listener)
  }

  /**
   * Simulates a streaming rewrite: reveals `finalText` word-by-word over
   * roughly `totalDelayMs`, emitting each growing prefix via
   * 'text-stream-progress' (when `operationId` is given) - exercises the
   * exact same renderer-facing streaming path `LitertBackend` uses for
   * cleanup/transform/voiceEdit, so the UX is demoable without a real model.
   * Falls back to a flat delay (no progress events) when there's no
   * `operationId` listening, or nothing to reveal.
   */
  private async streamText(
    finalText: string,
    totalDelayMs: number,
    operationId?: string
  ): Promise<string> {
    if (!operationId || !finalText) {
      await delay(totalDelayMs)
      return finalText
    }

    const words = finalText.split(/(\s+)/).filter((part) => part.length > 0)
    const stepMs = Math.min(STREAM_STEP_MS, Math.max(1, totalDelayMs / words.length))
    let revealed = ''
    for (const word of words) {
      revealed += word
      this.emitter.emit('text-stream-progress', operationId, revealed)
      await delay(stepMs)
    }
    return finalText
  }

  async cleanup(text: string, operationId?: string): Promise<string> {
    return this.streamText(cleanupText(text), CLEANUP_DELAY_MS, operationId)
  }

  async transform(text: string, mode: TransformMode, operationId?: string): Promise<string> {
    return this.streamText(transformText(text, mode), TRANSFORM_DELAY_MS, operationId)
  }

  async voiceEdit(text: string, command: string, operationId?: string): Promise<string> {
    return this.streamText(applyVoiceEdit(text, command), VOICE_EDIT_DELAY_MS, operationId)
  }
}
