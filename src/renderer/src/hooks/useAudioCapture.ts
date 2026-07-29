import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioChunkPayload } from '@shared/backend'

// Served as a static asset from src/renderer/public - see that file for
// why this can't just be a normal bundled module.
const WORKLET_URL = `${import.meta.env.BASE_URL}pcm-worklet-processor.js`

export interface UseAudioCapture {
  start: () => Promise<void>
  stop: () => void
  /** Non-null when capture fell back to the compressed-audio path, or mic access failed. */
  warning: string | null
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
  }, [])

  const startWithWorklet = useCallback(async (stream: MediaStream) => {
    const audioContext = new AudioContext({ sampleRate: 16000 })
    audioContextRef.current = audioContext
    await audioContext.audioWorklet.addModule(WORKLET_URL)

    const source = audioContext.createMediaStreamSource(stream)
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor')
    workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
      onChunkRef.current({ kind: 'pcm16', buffer: event.data, sampleRate: 16000 })
    }
    source.connect(workletNode)
    workletNodeRef.current = workletNode
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

  return { start, stop, warning }
}
