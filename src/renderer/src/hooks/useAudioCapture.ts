import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioChunkPayload } from '@shared/backend'

// Served as a static asset from src/renderer/public - see that file for
// why this can't just be a normal bundled module.
const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet-processor.js`

/** Normalized (0-1) RMS level below which incoming PCM is treated as silence for the "no audio detected" warning. */
const SILENCE_LEVEL_THRESHOLD = 0.01
/** How long the level has to stay under the threshold before we warn the user. */
const SILENCE_WARNING_MS = 2000

export interface UseAudioCapture {
  /** Rejects (with a clear message) if mic access or the AudioWorklet pipeline fails - no fallback path, caller must handle this as a hard stop. */
  start: () => Promise<void>
  stop: () => void
  /** Current normalized (0-1) mic input level, computed from the RMS of live PCM16 chunks. */
  level: number
  /**
   * True once `level` has stayed at/near zero for more than ~2s while a
   * capture session is active - a strong signal the mic is delivering
   * silence (e.g. a getUserMedia/WSLg binding issue) even though capture
   * itself is "working".
   */
  noAudioDetected: boolean
}

/** Root-mean-square amplitude of a PCM16 sample buffer, normalized to 0-1. */
function computeNormalizedRms(int16: Int16Array): number {
  if (int16.length === 0) return 0
  let sumSquares = 0
  for (let i = 0; i < int16.length; i++) {
    sumSquares += int16[i] * int16[i]
  }
  return Math.min(1, Math.sqrt(sumSquares / int16.length) / 32768)
}

/** Reports a capture failure to main.log (see src/main/log.ts) via the one renderer -> main log IPC channel. */
function logCaptureFailure(reason: string): void {
  window.api.log.rendererError(`mic capture failed: ${reason}`)
}

/**
 * Captures microphone audio in the renderer and hands fixed-size chunks to
 * `onChunk` as they're produced, over a 16kHz mono PCM16 AudioWorklet
 * pipeline - PCM only, no fallback. Chunks are forwarded to the main process
 * over IPC, which routes them into the active InferenceBackend session. If
 * mic access or the AudioWorklet pipeline fails, `start()` rejects and logs
 * the reason - the caller must treat that as a hard stop, not retry with a
 * degraded capture path.
 */
export function useAudioCapture(onChunk: (payload: AudioChunkPayload) => void): UseAudioCapture {
  const onChunkRef = useRef(onChunk)
  useEffect(() => {
    onChunkRef.current = onChunk
  }, [onChunk])

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const [level, setLevel] = useState(0)
  const [noAudioDetected, setNoAudioDetected] = useState(false)
  const lastNonSilentAtRef = useRef(0)
  const silenceCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    workletNodeRef.current?.port.close()
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null

    if (audioContextRef.current && audioContextRef.current.state !== 'closed') {
      audioContextRef.current.close().catch(() => {})
    }
    audioContextRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    if (silenceCheckTimerRef.current !== null) {
      clearInterval(silenceCheckTimerRef.current)
      silenceCheckTimerRef.current = null
    }
    setLevel(0)
    setNoAudioDetected(false)
  }, [])

  const startWithWorklet = useCallback(async (stream: MediaStream) => {
    const audioContext = new AudioContext({ sampleRate: 16000 })
    audioContextRef.current = audioContext
    await audioContext.audioWorklet.addModule(WORKLET_URL)

    const source = audioContext.createMediaStreamSource(stream)
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor')
    lastNonSilentAtRef.current = Date.now()
    setNoAudioDetected(false)
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      const int16 = new Int16Array(event.data)
      const normalized = computeNormalizedRms(int16)
      setLevel(normalized)
      if (normalized >= SILENCE_LEVEL_THRESHOLD) lastNonSilentAtRef.current = Date.now()
      onChunkRef.current({ buffer: event.data, sampleRate: 16000 })
    }
    source.connect(workletNode)
    workletNodeRef.current = workletNode

    silenceCheckTimerRef.current = setInterval(() => {
      setNoAudioDetected(Date.now() - lastNonSilentAtRef.current > SILENCE_WARNING_MS)
    }, 500)
  }, [])

  const start = useCallback(async () => {
    let stream: MediaStream
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      logCaptureFailure(`getUserMedia: ${reason}`)
      throw new Error(reason)
    }
    streamRef.current = stream

    if (typeof AudioWorkletNode === 'undefined') {
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const reason = 'AudioWorklet is not supported in this environment'
      logCaptureFailure(reason)
      throw new Error(reason)
    }

    try {
      await startWithWorklet(stream)
    } catch (err) {
      stream.getTracks().forEach((track) => track.stop())
      streamRef.current = null
      const reason = err instanceof Error ? err.message : String(err)
      logCaptureFailure(`AudioWorklet: ${reason}`)
      throw new Error(reason)
    }
  }, [startWithWorklet])

  useEffect(() => stop, [stop])

  return { start, stop, level, noAudioDetected }
}
