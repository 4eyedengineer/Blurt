import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioChunkPayload, TransformMode } from '@shared/backend'
import type { DictationDisplayMode, DictationEntry } from '@shared/types'
import { useSettings } from '../context/SettingsContext'
import { useAudioCapture } from './useAudioCapture'
import { computeStats, type SessionStats } from '../lib/format'
import { copyToClipboard } from '../lib/clipboard'
import { diffWords, type DiffToken } from '../lib/wordDiff'

export type DictationPhase =
  | 'idle'
  | 'recording'
  /** Between "recording stopped" and "final transcript obtained" - the final re-transcription still streams in via liveText. */
  | 'finalizing'
  | 'cleaning'
  | 'ready'
  | 'transforming'

/** How long the inline word-diff view stays up after a cleanup pass before settling to the plain cleaned text. */
const CLEANUP_REVEAL_MS = 2000
/** Same idea for voice-edit, which is a much smaller/cheaper change - a shorter beat is enough. */
const VOICE_EDIT_REVEAL_MS = 1200

export interface UseDictationSession {
  phase: DictationPhase
  liveText: string
  displayText: string
  cleanedText: string
  rawTranscript: string
  displayMode: DictationDisplayMode
  stats: SessionStats | null
  copyFlash: boolean
  sessionError: string | null
  /** Normalized 0-1 live mic input level - see useAudioCapture. */
  micLevel: number
  /** True once the mic level has read ~zero for >2s while recording - see useAudioCapture. */
  noAudioDetected: boolean
  /** Growing preview text for an in-flight cleanup/transform streamed rewrite - see `phase` ('cleaning' | 'transforming'). Empty once settled. */
  streamPreview: string
  /** Non-null while the brief inline diff-reveal (raw -> cleaned, or pre- -> post-voice-edit) is showing; render this instead of `displayText` when set. */
  reveal: DiffToken[] | null
  toggleRecording: () => void
  applyTransform: (mode: TransformMode) => Promise<void>
  applyVoiceEdit: (command: string) => Promise<void>
  copyDisplayText: () => Promise<boolean>
  loadFromHistory: (entry: DictationEntry) => void
  startNew: () => void
}

const emptyStats = (): SessionStats => ({ wordCount: 0, durationMs: 0, wpm: 0 })

export function useDictationSession(): UseDictationSession {
  const { settings } = useSettings()

  const [phase, setPhase] = useState<DictationPhase>('idle')
  const [liveText, setLiveText] = useState('')
  const [rawTranscript, setRawTranscript] = useState('')
  const [cleanedText, setCleanedText] = useState('')
  const [displayText, setDisplayText] = useState('')
  const [displayMode, setDisplayMode] = useState<DictationDisplayMode>('none')
  const [stats, setStats] = useState<SessionStats | null>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [copyFlash, setCopyFlash] = useState(false)
  const [sessionError, setSessionError] = useState<string | null>(null)
  const [streamPreview, setStreamPreview] = useState('')
  const [reveal, setReveal] = useState<DiffToken[] | null>(null)

  const sessionIdRef = useRef<string | null>(null)
  const startTimeRef = useRef(0)
  const unsubscribePartialRef = useRef<() => void>(() => {})
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const flashCopy = useCallback(() => {
    setCopyFlash(true)
    setTimeout(() => setCopyFlash(false), 1500)
  }, [])

  const clearRevealTimer = useCallback(() => {
    if (revealTimerRef.current) {
      clearTimeout(revealTimerRef.current)
      revealTimerRef.current = null
    }
  }, [])

  /** Shows an inline diff view for `durationMs`, replacing whatever's currently revealed (if anything). */
  const showReveal = useCallback(
    (tokens: DiffToken[], durationMs: number) => {
      clearRevealTimer()
      setReveal(tokens)
      revealTimerRef.current = setTimeout(() => {
        setReveal(null)
        revealTimerRef.current = null
      }, durationMs)
    },
    [clearRevealTimer]
  )

  useEffect(() => clearRevealTimer, [clearRevealTimer])

  /**
   * Runs a cleanup/transform call while streaming its incremental progress
   * into `streamPreview` (see `onTextStreamProgress` / the generic
   * 'text-stream-progress' IPC event) - mints a fresh operation id so
   * concurrent/stale progress events can't cross-talk.
   */
  const withStreamPreview = useCallback(
    async <T>(run: (operationId: string) => Promise<T>): Promise<T> => {
      const operationId = crypto.randomUUID()
      setStreamPreview('')
      const unsubscribe = window.api.dictation.onTextStreamProgress((opId, text) => {
        if (opId === operationId) setStreamPreview(text)
      })
      try {
        return await run(operationId)
      } finally {
        unsubscribe()
        setStreamPreview('')
      }
    },
    []
  )

  const handleChunk = useCallback((payload: AudioChunkPayload) => {
    if (sessionIdRef.current) {
      window.api.dictation.pushAudio(sessionIdRef.current, payload)
    }
  }, [])

  const audio = useAudioCapture(handleChunk)

  const startNew = useCallback(() => {
    clearRevealTimer()
    setPhase('idle')
    setLiveText('')
    setRawTranscript('')
    setCleanedText('')
    setDisplayText('')
    setDisplayMode('none')
    setStats(null)
    setEntryId(null)
    setStreamPreview('')
    setReveal(null)
  }, [clearRevealTimer])

  const startRecording = useCallback(async () => {
    startNew()
    setSessionError(null)
    setPhase('recording')

    const sessionId = await window.api.dictation.startSession({
      sampleRate: 16000,
      vocabulary: settings.customVocabulary
    })
    sessionIdRef.current = sessionId
    startTimeRef.current = Date.now()

    const unsubscribePartial = window.api.dictation.onPartialTranscript((sid, text) => {
      if (sid === sessionId) setLiveText(text)
    })
    const unsubscribeError = window.api.dictation.onSessionError((sid, error) => {
      if (sid === sessionId) setSessionError(error.message)
    })
    unsubscribePartialRef.current = () => {
      unsubscribePartial()
      unsubscribeError()
    }

    try {
      await audio.start()
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      unsubscribePartialRef.current()
      sessionIdRef.current = null
      setPhase('idle')
      setSessionError(`Microphone capture failed: ${reason}`)
      void window.api.dictation.endSession(sessionId)
    }
  }, [audio, settings.customVocabulary, startNew])

  const stopRecording = useCallback(async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    sessionIdRef.current = null

    audio.stop()
    const durationMs = Date.now() - startTimeRef.current
    // 'finalizing': the final re-transcription of the whole buffer is still
    // streaming in over the same partial-transcript channel (see
    // LitertBackend.endSession) - keep showing liveText, and don't
    // unsubscribe until it's actually done.
    setPhase('finalizing')

    const finalRaw = await window.api.dictation.endSession(sessionId)
    unsubscribePartialRef.current()
    setRawTranscript(finalRaw)
    setLiveText(finalRaw)
    setPhase('cleaning')

    const cleaned = await withStreamPreview((operationId) =>
      window.api.dictation.cleanup(finalRaw, operationId)
    )
    setCleanedText(cleaned)
    setDisplayText(cleaned)
    setDisplayMode('none')

    const sessionStats = computeStats(cleaned, durationMs)
    setStats(sessionStats)
    setPhase('ready')
    // The visual diff-reveal is purely cosmetic and lingers a couple of
    // seconds - but the underlying data (displayText above, clipboard/
    // history below) is already final and must not wait on it.
    showReveal(diffWords(finalRaw, cleaned), CLEANUP_REVEAL_MS)

    if (settings.autoCopyOnCleanup) {
      const ok = await copyToClipboard(cleaned)
      if (ok) flashCopy()
    }

    const saved = await window.api.history.save({
      rawTranscript: finalRaw,
      cleanedText: cleaned,
      displayText: cleaned,
      displayMode: 'none',
      wordCount: sessionStats.wordCount,
      durationMs: sessionStats.durationMs,
      wpm: sessionStats.wpm
    })
    setEntryId(saved.id)
  }, [audio, flashCopy, settings.autoCopyOnCleanup, showReveal, withStreamPreview])

  const toggleRecording = useCallback(() => {
    if (phase === 'recording') {
      void stopRecording()
    } else if (phase === 'idle' || phase === 'ready') {
      void startRecording()
    }
  }, [phase, startRecording, stopRecording])

  const persistCurrent = useCallback(
    async (patch: Partial<Pick<DictationEntry, 'displayText' | 'displayMode'>>) => {
      if (!entryId) return
      const s = stats ?? emptyStats()
      const saved = await window.api.history.save({
        id: entryId,
        rawTranscript,
        cleanedText,
        displayText: patch.displayText ?? displayText,
        displayMode: patch.displayMode ?? displayMode,
        wordCount: s.wordCount,
        durationMs: s.durationMs,
        wpm: s.wpm
      })
      setEntryId(saved.id)
    },
    [entryId, rawTranscript, cleanedText, displayText, displayMode, stats]
  )

  const applyTransform = useCallback(
    async (mode: TransformMode) => {
      const source = cleanedText || displayText
      if (!source) return
      setPhase('transforming')
      const transformed = await withStreamPreview((operationId) =>
        window.api.dictation.transform(source, mode, operationId)
      )
      setDisplayText(transformed)
      setDisplayMode(mode)
      setPhase('ready')
      await persistCurrent({ displayText: transformed, displayMode: mode })
    },
    [cleanedText, displayText, persistCurrent, withStreamPreview]
  )

  const applyVoiceEdit = useCallback(
    async (command: string) => {
      if (!displayText || !command.trim()) return
      const before = displayText
      const edited = await window.api.dictation.voiceEdit(displayText, command)
      setDisplayText(edited)
      showReveal(diffWords(before, edited), VOICE_EDIT_REVEAL_MS)
      await persistCurrent({ displayText: edited })
    },
    [displayText, persistCurrent, showReveal]
  )

  const copyDisplayText = useCallback(async () => {
    const ok = await copyToClipboard(displayText)
    if (ok) flashCopy()
    return ok
  }, [displayText, flashCopy])

  const loadFromHistory = useCallback(
    (entry: DictationEntry) => {
      clearRevealTimer()
      sessionIdRef.current = null
      setPhase('ready')
      setLiveText('')
      setStreamPreview('')
      setReveal(null)
      setEntryId(entry.id)
      setRawTranscript(entry.rawTranscript)
      setCleanedText(entry.cleanedText)
      setDisplayText(entry.displayText)
      setDisplayMode(entry.displayMode)
      setStats({ wordCount: entry.wordCount, durationMs: entry.durationMs, wpm: entry.wpm })
    },
    [clearRevealTimer]
  )

  // Global hotkey toggles recording from anywhere (main process brings the
  // window to front before sending this event).
  useEffect(() => window.api.hotkey.onToggleRecording(() => toggleRecording()), [toggleRecording])

  return {
    phase,
    liveText,
    displayText,
    cleanedText,
    rawTranscript,
    displayMode,
    stats,
    copyFlash,
    sessionError,
    micLevel: audio.level,
    noAudioDetected: audio.noAudioDetected,
    streamPreview,
    reveal,
    toggleRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    loadFromHistory,
    startNew
  }
}
