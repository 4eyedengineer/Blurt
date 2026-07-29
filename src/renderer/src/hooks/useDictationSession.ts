import { useCallback, useEffect, useRef, useState } from 'react'
import type { AudioChunkPayload, TransformMode } from '@shared/backend'
import type { DictationDisplayMode, DictationEntry } from '@shared/types'
import { useSettings } from '../context/SettingsContext'
import { useAudioCapture } from './useAudioCapture'
import { computeStats, type SessionStats } from '../lib/format'
import { copyToClipboard } from '../lib/clipboard'

export type DictationPhase = 'idle' | 'recording' | 'cleaning' | 'ready' | 'transforming'

export interface UseDictationSession {
  phase: DictationPhase
  liveText: string
  displayText: string
  cleanedText: string
  rawTranscript: string
  displayMode: DictationDisplayMode
  stats: SessionStats | null
  copyFlash: boolean
  audioWarning: string | null
  sessionError: string | null
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

  const sessionIdRef = useRef<string | null>(null)
  const startTimeRef = useRef(0)
  const unsubscribePartialRef = useRef<() => void>(() => {})

  const flashCopy = useCallback(() => {
    setCopyFlash(true)
    setTimeout(() => setCopyFlash(false), 1500)
  }, [])

  const handleChunk = useCallback((payload: AudioChunkPayload) => {
    if (sessionIdRef.current) {
      window.api.dictation.pushAudio(sessionIdRef.current, payload)
    }
  }, [])

  const audio = useAudioCapture(handleChunk)

  const startNew = useCallback(() => {
    setPhase('idle')
    setLiveText('')
    setRawTranscript('')
    setCleanedText('')
    setDisplayText('')
    setDisplayMode('none')
    setStats(null)
    setEntryId(null)
  }, [])

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

    await audio.start()
  }, [audio, settings.customVocabulary, startNew])

  const stopRecording = useCallback(async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    sessionIdRef.current = null

    audio.stop()
    unsubscribePartialRef.current()

    const durationMs = Date.now() - startTimeRef.current
    const finalRaw = await window.api.dictation.endSession(sessionId)
    setRawTranscript(finalRaw)
    setPhase('cleaning')

    const cleaned = await window.api.dictation.cleanup(finalRaw)
    setCleanedText(cleaned)
    setDisplayText(cleaned)
    setDisplayMode('none')

    const sessionStats = computeStats(cleaned, durationMs)
    setStats(sessionStats)
    setPhase('ready')

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
  }, [audio, flashCopy, settings.autoCopyOnCleanup])

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
      const transformed = await window.api.dictation.transform(source, mode)
      setDisplayText(transformed)
      setDisplayMode(mode)
      setPhase('ready')
      await persistCurrent({ displayText: transformed, displayMode: mode })
    },
    [cleanedText, displayText, persistCurrent]
  )

  const applyVoiceEdit = useCallback(
    async (command: string) => {
      if (!displayText || !command.trim()) return
      const edited = await window.api.dictation.voiceEdit(displayText, command)
      setDisplayText(edited)
      await persistCurrent({ displayText: edited })
    },
    [displayText, persistCurrent]
  )

  const copyDisplayText = useCallback(async () => {
    const ok = await copyToClipboard(displayText)
    if (ok) flashCopy()
    return ok
  }, [displayText, flashCopy])

  const loadFromHistory = useCallback((entry: DictationEntry) => {
    sessionIdRef.current = null
    setPhase('ready')
    setLiveText('')
    setEntryId(entry.id)
    setRawTranscript(entry.rawTranscript)
    setCleanedText(entry.cleanedText)
    setDisplayText(entry.displayText)
    setDisplayMode(entry.displayMode)
    setStats({ wordCount: entry.wordCount, durationMs: entry.durationMs, wpm: entry.wpm })
  }, [])

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
    audioWarning: audio.warning,
    sessionError,
    toggleRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    loadFromHistory,
    startNew
  }
}
