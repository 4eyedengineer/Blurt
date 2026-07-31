import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { AudioChunkPayload } from '@shared/backend'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { initialOverlayState, overlayReducer, type OverlayPhase } from './overlayState'
import type { DiffToken } from '../lib/wordDiff'

/** How long the compact inline diff-reveal stays up in the pill before settling to the plain final text. */
const REVEAL_SETTLE_MS = 1500

export interface UseOverlayPushToTalk {
  phase: OverlayPhase
  liveText: string
  finalText: string
  diffTokens: DiffToken[]
  micLevel: number
  copied: boolean
  pasted: boolean
  pasteMessage: string | null
  errorMessage: string | null
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
  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  const handleChunk = useCallback((payload: AudioChunkPayload) => {
    if (sessionIdRef.current) {
      window.api.dictation.pushAudio(sessionIdRef.current, payload)
    }
  }, [])

  const audio = useAudioCapture(handleChunk)

  const start = useCallback(async () => {
    clearSettleTimer()
    dispatch({ type: 'start' })
    const sessionId = await window.api.dictation.startSession({ sampleRate: 16000 })
    sessionIdRef.current = sessionId
    unsubscribePartialRef.current = window.api.dictation.onPartialTranscript((sid, text) => {
      if (sid === sessionId) dispatch({ type: 'partial', text })
    })
    try {
      await audio.start()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      window.api.log.rendererError(`overlay mic capture failed: ${reason}`)
      unsubscribePartialRef.current()
      sessionIdRef.current = null
      void window.api.dictation.endSession(sessionId).catch(() => {})
      dispatch({ type: 'failed', message: `Microphone capture failed: ${reason}` })
      clearSettleTimer()
      settleTimerRef.current = setTimeout(() => {
        dispatch({ type: 'reset' })
        settleTimerRef.current = null
      }, REVEAL_SETTLE_MS)
    }
  }, [audio, clearSettleTimer])

  /**
   * Always reports back to the main process - success or failure. The pill
   * is only ever hidden in response to this (see overlayController.ts), so
   * a silent early return or a thrown transcription error would leave it
   * floating on screen forever with no way to dismiss it.
   */
  const stop = useCallback(async () => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    unsubscribePartialRef.current()
    audio.stop()
    if (!sessionId) {
      window.api.overlay.sendResult({
        rawTranscript: '',
        cleanedText: '',
        error: 'No dictation session was running when the key was released.'
      })
      return
    }

    dispatch({ type: 'stop' })
    try {
      const raw = await window.api.dictation.endSession(sessionId)
      const cleaned = await window.api.dictation.cleanup(raw)
      dispatch({ type: 'cleaned', raw, text: cleaned })
      // Clipboard copy/paste fire immediately on cleanup completion - only the
      // visual diff-reveal (settled via the timer below) lingers.
      window.api.overlay.sendResult({ rawTranscript: raw, cleanedText: cleaned })

      clearSettleTimer()
      settleTimerRef.current = setTimeout(() => {
        dispatch({ type: 'settle' })
        settleTimerRef.current = null
      }, REVEAL_SETTLE_MS)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      window.api.log.rendererError(`overlay dictation failed: ${reason}`)
      dispatch({ type: 'failed', message: reason })
      window.api.overlay.sendResult({ rawTranscript: '', cleanedText: '', error: reason })
    }
  }, [audio, clearSettleTimer])

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    unsubscribePartialRef.current()
    audio.stop()
    clearSettleTimer()
    dispatch({ type: 'cancel' })
    // Accidental tap - still tear down the backend session, but discard the
    // result (no cleanup/copy/paste for a gesture the user didn't intend).
    if (sessionId) void window.api.dictation.endSession(sessionId).catch(() => {})
  }, [audio, clearSettleTimer])

  useEffect(() => {
    const offStart = window.api.overlay.onPttStart(() => void start())
    const offStop = window.api.overlay.onPttStop(() => void stop())
    const offCancel = window.api.overlay.onPttCancel(() => cancel())
    const offReset = window.api.overlay.onReset(() => {
      clearSettleTimer()
      dispatch({ type: 'reset' })
    })
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
      clearSettleTimer()
    }
  }, [start, stop, cancel, clearSettleTimer])

  return {
    phase: state.phase,
    liveText: state.liveText,
    finalText: state.finalText,
    diffTokens: state.diffTokens,
    micLevel: audio.level,
    copied: state.copied,
    pasted: state.pasted,
    pasteMessage: state.pasteMessage,
    errorMessage: state.errorMessage
  }
}
