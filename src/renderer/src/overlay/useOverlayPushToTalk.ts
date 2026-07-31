import { useCallback, useEffect, useReducer, useRef } from 'react'
import type { AudioChunkPayload } from '@shared/backend'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { initialOverlayState, overlayReducer, type OverlayPhase } from './overlayState'
import type { DiffToken } from '../lib/wordDiff'
import { playReadyTone } from '../lib/readyTone'

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
  /**
   * When the first PCM chunk of this hold arrived, i.e. when capture was
   * genuinely live - null until then. Used both to fire the ready tone
   * exactly once and as the start of the dictation's duration: the ~1s
   * device-open window before this is dead air the user wasn't speaking
   * into, so timing from the keypress would understate their real WPM.
   */
  const captureLiveAtRef = useRef<number | null>(null)

  const clearSettleTimer = useCallback(() => {
    if (settleTimerRef.current) {
      clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
  }, [])

  const handleChunk = useCallback((payload: AudioChunkPayload) => {
    if (!sessionIdRef.current) return
    // The first chunk is the only honest "you can talk now" signal - it
    // means the mic is open and PCM is flowing, which is up to a second or
    // two after the key went down (see readyTone.ts).
    if (captureLiveAtRef.current === null) {
      captureLiveAtRef.current = Date.now()
      playReadyTone()
    }
    window.api.dictation.pushAudio(sessionIdRef.current, payload)
  }, [])

  const audio = useAudioCapture(handleChunk)

  const start = useCallback(async () => {
    clearSettleTimer()
    captureLiveAtRef.current = null
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
    const liveAt = captureLiveAtRef.current
    captureLiveAtRef.current = null
    if (!sessionId) {
      window.api.overlay.sendResult({
        rawTranscript: '',
        cleanedText: '',
        durationMs: 0,
        error: 'No dictation session was running when the key was released.'
      })
      return
    }

    dispatch({ type: 'stop' })
    // 0 if capture never went live - that's a dictation with no audio, and
    // an invented duration would only produce a nonsense WPM in history.
    const durationMs = liveAt === null ? 0 : Date.now() - liveAt
    try {
      const raw = await window.api.dictation.endSession(sessionId)
      const cleaned = await window.api.dictation.cleanup(raw)
      dispatch({ type: 'cleaned', raw, text: cleaned })
      // Clipboard copy/paste and the history write both fire immediately on
      // cleanup completion - only the visual diff-reveal (settled via the
      // timer below) lingers.
      window.api.overlay.sendResult({ rawTranscript: raw, cleanedText: cleaned, durationMs })

      clearSettleTimer()
      settleTimerRef.current = setTimeout(() => {
        dispatch({ type: 'settle' })
        settleTimerRef.current = null
      }, REVEAL_SETTLE_MS)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      window.api.log.rendererError(`overlay dictation failed: ${reason}`)
      dispatch({ type: 'failed', message: reason })
      window.api.overlay.sendResult({
        rawTranscript: '',
        cleanedText: '',
        durationMs,
        error: reason
      })
    }
  }, [audio, clearSettleTimer])

  const cancel = useCallback(() => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    captureLiveAtRef.current = null
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
