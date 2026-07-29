import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { AudioChunkPayload } from '@shared/backend'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { initialOverlayState, overlayReducer, type OverlayPhase } from './overlayState'

export interface UseOverlayPushToTalk {
  phase: OverlayPhase
  liveText: string
  finalText: string
  micLevel: number
  copied: boolean
  pasted: boolean
  pasteMessage: string | null
}

/**
 * Drives the overlay's own dictation session from main-process 'ptt-*' IPC
 * events (see src/main/overlayController.ts), reusing the exact same
 * `window.api.dictation.*` bridge and `useAudioCapture` hook the main
 * Dictate screen uses (src/renderer/src/hooks/useDictationSession.ts) - so
 * there is exactly one place (backendIpc.ts) that talks to the active
 * InferenceBackend.
 */
export function useOverlayPushToTalk(): UseOverlayPushToTalk {
  const [state, dispatch] = useReducer(overlayReducer, initialOverlayState)
  const sessionIdRef = useRef<string | null>(null)
  const unsubscribePartialRef = useRef<() => void>(() => {})

  const handleChunk = useCallback((payload: AudioChunkPayload) => {
    if (sessionIdRef.current) {
      window.api.dictation.pushAudio(sessionIdRef.current, payload)
    }
  }, [])

  const audio = useAudioCapture(handleChunk)

  const start = useCallback(async () => {
    dispatch({ type: 'start' })
    const sessionId = await window.api.dictation.startSession({ sampleRate: 16000 })
    sessionIdRef.current = sessionId
    unsubscribePartialRef.current = window.api.dictation.onPartialTranscript((sid, text) => {
      if (sid === sessionId) dispatch({ type: 'partial', text })
    })
    await audio.start()
  }, [audio])

  const stop = useCallback(async () => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    unsubscribePartialRef.current()
    audio.stop()
    if (!sessionId) return

    dispatch({ type: 'stop' })
    const raw = await window.api.dictation.endSession(sessionId)
    const cleaned = await window.api.dictation.cleanup(raw)
    dispatch({ type: 'cleaned', text: cleaned })
    window.api.overlay.sendResult({ rawTranscript: raw, cleanedText: cleaned })
  }, [audio])

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    unsubscribePartialRef.current()
    audio.stop()
    dispatch({ type: 'cancel' })
    // Accidental tap - still tear down the backend session, but discard the
    // result (no cleanup/copy/paste for a gesture the user didn't intend).
    if (sessionId) void window.api.dictation.endSession(sessionId).catch(() => {})
  }, [audio])

  useEffect(() => {
    const offStart = window.api.overlay.onPttStart(() => void start())
    const offStop = window.api.overlay.onPttStop(() => void stop())
    const offCancel = window.api.overlay.onPttCancel(() => cancel())
    const offReset = window.api.overlay.onReset(() => dispatch({ type: 'reset' }))
    const offPaste = window.api.overlay.onPasteStatus((status) =>
      dispatch({
        type: 'paste-status',
        copied: status.copied,
        pasted: status.pasted,
        message: status.message
      })
    )
    return () => {
      offStart()
      offStop()
      offCancel()
      offReset()
      offPaste()
    }
  }, [start, stop, cancel])

  return {
    phase: state.phase,
    liveText: state.liveText,
    finalText: state.finalText,
    micLevel: audio.level,
    copied: state.copied,
    pasted: state.pasted,
    pasteMessage: state.pasteMessage
  }
}
