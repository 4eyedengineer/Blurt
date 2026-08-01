import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioChunkPayload } from '@shared/backend'

// Served as a static asset from src/renderer/public - see that file for
// why this can't just be a normal bundled module.
const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet-processor.js`

/** Normalized (0-1) RMS level below which incoming PCM is treated as silence for the "no audio detected" warning. */
const SILENCE_LEVEL_THRESHOLD = 0.01
/** How long the level has to stay under the threshold before we warn the user. */
const SILENCE_WARNING_MS = 2000
/**
 * How long to wait for the first PCM chunk before logging why it never
 * came. Generous: opening the audio device on Windows can take a second or
 * two on its own, and this must never fire on a slow-but-working start.
 */
const NO_CHUNK_TIMEOUT_MS = 3000

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
  /** The muted node that keeps the worklet reachable from the destination - see startWithWorklet. */
  const sinkRef = useRef<GainNode | null>(null)
  const noChunkTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [level, setLevel] = useState(0)
  const [noAudioDetected, setNoAudioDetected] = useState(false)
  const lastNonSilentAtRef = useRef(0)
  const silenceCheckTimerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const stop = useCallback(() => {
    if (noChunkTimerRef.current !== null) {
      clearTimeout(noChunkTimerRef.current)
      noChunkTimerRef.current = null
    }

    workletNodeRef.current?.port.close()
    workletNodeRef.current?.disconnect()
    workletNodeRef.current = null

    sinkRef.current?.disconnect()
    sinkRef.current = null

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

    // A newly constructed AudioContext can come up 'suspended', and a
    // suspended context renders nothing at all: no render quanta, so the
    // worklet's process() is never called and not one chunk is produced.
    // Nothing throws in that state, which is what makes it so unpleasant to
    // diagnose - capture looks like it started and simply stays silent
    // forever. The main window usually escapes this because pressing Record
    // is a user gesture; the push-to-talk overlay never receives a gesture
    // at all (it is `focusable: false` and driven entirely by a global key
    // hook), so it has no way to be resumed implicitly.
    if (audioContext.state === 'suspended') await audioContext.resume()

    const source = audioContext.createMediaStreamSource(stream)
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor')
    lastNonSilentAtRef.current = Date.now()
    setNoAudioDetected(false)
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      if (noChunkTimerRef.current !== null) {
        clearTimeout(noChunkTimerRef.current)
        noChunkTimerRef.current = null
      }
      const int16 = new Int16Array(event.data)
      const normalized = computeNormalizedRms(int16)
      setLevel(normalized)
      if (normalized >= SILENCE_LEVEL_THRESHOLD) lastNonSilentAtRef.current = Date.now()
      onChunkRef.current({ buffer: event.data, sampleRate: 16000 })
    }
    source.connect(workletNode)

    // The worklet has to stay reachable from the context's destination.
    // Chromium renders the graph by pulling from the destination, so a node
    // with no path to it is not guaranteed to be pulled, and an unpulled
    // worklet produces no chunks while reporting no error. Routing through
    // a muted gain node keeps it in the rendered graph without putting the
    // microphone through the speakers.
    const sink = audioContext.createGain()
    sink.gain.value = 0
    workletNode.connect(sink)
    sink.connect(audioContext.destination)
    sinkRef.current = sink

    workletNodeRef.current = workletNode

    // If the very first chunk never arrives, say why. Both failures above
    // are silent by nature, and without this the only evidence is an empty
    // transcript, which is indistinguishable from "nobody spoke".
    noChunkTimerRef.current = setTimeout(() => {
      noChunkTimerRef.current = null
      const track = stream.getAudioTracks()[0]
      logCaptureFailure(
        `no PCM chunk ${NO_CHUNK_TIMEOUT_MS}ms after capture started. ` +
          `context.state=${audioContext.state} context.sampleRate=${audioContext.sampleRate} ` +
          `track=${track ? `${track.label || 'unnamed'} readyState=${track.readyState} muted=${track.muted} enabled=${track.enabled}` : 'none'}`
      )
    }, NO_CHUNK_TIMEOUT_MS)

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
