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
  start: () => Promise<void>
  stop: () => void
  /** Non-null when capture fell back to the compressed-audio path, or mic access failed. */
  warning: string | null
  /**
   * Current normalized (0-1) mic input level, computed from the RMS of live
   * PCM16 chunks as they flow through the AudioWorklet path. Stays 0 when
   * capture is on the MediaRecorder/webm fallback (no PCM to meter there).
   */
  level: number
  /**
   * True once `level` has stayed at/near zero for more than ~2s while a PCM
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

/**
 * Captures microphone audio in the renderer and hands fixed-size chunks to
 * `onChunk` as they're produced. Prefers a 16kHz mono PCM16 AudioWorklet
 * pipeline; falls back to MediaRecorder (webm/opus) if AudioWorklet isn't
 * available. Chunks are forwarded to the main process over IPC, which
 * routes them into the active InferenceBackend session.
 */
export function useAudioCapture(onChunk: (payload: AudioChunkPayload) => void): UseAudioCapture {
  const onChunkRef = useRef(onChunk)
  useEffect(() => {
    onChunkRef.current = onChunk
  }, [onChunk])

  const streamRef = useRef<MediaStream | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | null>(null)
  const mediaRecorderRef = useRef<MediaRecorder | null>(null)
  const [warning, setWarning] = useState<string | null>(null)
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

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop()
    }
    mediaRecorderRef.current = null

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
      onChunkRef.current({ kind: 'pcm16', buffer: event.data, sampleRate: 16000 })
    }
    source.connect(workletNode)
    workletNodeRef.current = workletNode

    silenceCheckTimerRef.current = setInterval(() => {
      setNoAudioDetected(Date.now() - lastNonSilentAtRef.current > SILENCE_WARNING_MS)
    }, 500)
  }, [])

  const startWithMediaRecorder = useCallback((stream: MediaStream) => {
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : undefined
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined)
    recorder.ondataavailable = (event) => {
      if (event.data.size === 0) return
      event.data.arrayBuffer().then((buffer) => {
        onChunkRef.current({ kind: 'opaque', buffer })
      })
    }
    recorder.start(250)
    mediaRecorderRef.current = recorder
  }, [])

  const start = useCallback(async () => {
    setWarning(null)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 16000,
        echoCancellation: true,
        noiseSuppression: true
      }
    })
    streamRef.current = stream

    try {
      if (typeof AudioWorkletNode === 'undefined') {
        throw new Error('AudioWorklet is not supported in this environment')
      }
      await startWithWorklet(stream)
    } catch (err) {
      console.warn('[useAudioCapture] Falling back to MediaRecorder capture:', err)
      setWarning('Using compressed-audio fallback (AudioWorklet unavailable on this system).')
      startWithMediaRecorder(stream)
    }
  }, [startWithWorklet, startWithMediaRecorder])

  useEffect(() => stop, [stop])

  return { start, stop, warning, level, noAudioDetected }
}
