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
  /**
   * Capturing a spoken edit instruction ("delete the last sentence") rather
   * than dictation. Same capture and transcription path as 'recording' - the
   * difference is only what the resulting text is used for: it becomes the
   * `command` argument to voiceEdit instead of the transcript being edited.
   */
  | 'command-recording'
  /** Applying an edit instruction to the transcript - streams like 'transforming'. */
  | 'editing'

/** How long the inline word-diff view stays up after a cleanup pass before settling to the plain cleaned text. */
const CLEANUP_REVEAL_MS = 2000
/**
 * Same idea for voice-edit, which is a much smaller/cheaper change - a
 * shorter beat is enough. Still has to outlast the full reveal sequence
 * (fade, then collapse - see DiffReveal.css), or the last of the collapse
 * gets cut off by the unmount and the text snaps the rest of the way.
 */
const VOICE_EDIT_REVEAL_MS = 1500

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
  /** Growing preview text for an in-flight cleanup/transform streamed rewrite - see `phase` ('cleaning' | 'transforming'). Empty once settled. */
  streamPreview: string
  /** Non-null while the brief inline diff-reveal (raw -> cleaned, or pre- -> post-voice-edit) is showing; render this instead of `displayText` when set. */
  reveal: DiffToken[] | null
  /**
   * The spoken edit instruction as recognized so far - updates live while
   * `phase === 'command-recording'` and settles to the final transcript when
   * recording stops. The edit bar mirrors this into its input, so the user
   * reads back what was actually heard and can correct it before applying.
   * Empty when no spoken command has been captured.
   */
  spokenCommand: string
  toggleRecording: () => void
  /** Starts/stops capturing a spoken edit instruction. No-op unless there is a transcript to edit. */
  toggleCommandRecording: () => void
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
  const [spokenCommand, setSpokenCommand] = useState('')

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
    setSpokenCommand('')
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
      await audio.start({ deviceId: settings.inputDeviceId })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      unsubscribePartialRef.current()
      sessionIdRef.current = null
      setPhase('idle')
      setSessionError(`Microphone capture failed: ${reason}`)
      void window.api.dictation.endSession(sessionId)
    }
  }, [audio, settings.customVocabulary, settings.inputDeviceId, startNew])

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

    // Nothing was said. Stop here rather than running the rest of the
    // pipeline over an empty string: the cleanup model, asked to tidy up
    // nothing, invents a plausible dictation instead of returning nothing
    // (see isBlank in src/main/backend/litertBackend.ts), and that
    // invention would then be copied to the clipboard and filed into
    // history as a real dictation.
    //
    // Straight back to 'idle', with no message: the empty transcript panel
    // already says everything there is to say, and the record button is
    // live again immediately. Announcing "no speech detected" would be
    // narrating a non-event back at someone who knows perfectly well they
    // didn't say anything.
    if (!finalRaw.trim()) {
      setPhase('idle')
      return
    }

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

  /**
   * Captures a spoken edit instruction. Reuses the dictation capture and
   * transcription path wholesale - same session API, same mic, same model -
   * because an edit command is just a short dictation whose text happens to
   * be an instruction rather than content.
   *
   * Deliberately does NOT call startNew(): the transcript being edited has
   * to survive this, so none of the session state is reset. It also cannot
   * overlap with dictation, since both use `sessionIdRef` and the one
   * `useAudioCapture` instance - which is fine, as there is nothing to edit
   * until a dictation has finished.
   */
  const startCommandRecording = useCallback(async () => {
    setSessionError(null)
    setSpokenCommand('')
    setPhase('command-recording')

    const sessionId = await window.api.dictation.startSession({
      sampleRate: 16000,
      vocabulary: settings.customVocabulary
    })
    sessionIdRef.current = sessionId

    // Stream the partial transcript straight into `spokenCommand` so the
    // edit bar fills in as the user speaks - the same live feedback the
    // transcript panel gives during dictation, and the user's only
    // confirmation the mic is actually hearing the instruction.
    const unsubscribePartial = window.api.dictation.onPartialTranscript((sid, text) => {
      if (sid === sessionId) setSpokenCommand(text)
    })
    const unsubscribeError = window.api.dictation.onSessionError((sid, error) => {
      if (sid === sessionId) setSessionError(error.message)
    })
    unsubscribePartialRef.current = () => {
      unsubscribePartial()
      unsubscribeError()
    }

    try {
      await audio.start({ deviceId: settings.inputDeviceId })
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      unsubscribePartialRef.current()
      sessionIdRef.current = null
      // Back to 'ready', not 'idle' - the transcript is still on screen and
      // still editable by typing; only the spoken shortcut failed.
      setPhase('ready')
      setSessionError(`Microphone capture failed: ${reason}`)
      void window.api.dictation.endSession(sessionId)
    }
  }, [audio, settings.customVocabulary, settings.inputDeviceId])

  const stopCommandRecording = useCallback(async () => {
    const sessionId = sessionIdRef.current
    if (!sessionId) return
    sessionIdRef.current = null

    audio.stop()
    setPhase('finalizing')

    const finalCommand = await window.api.dictation.endSession(sessionId)
    unsubscribePartialRef.current()
    setPhase('ready')

    // The command is handed to the edit bar rather than applied here. A
    // misheard instruction rewrites the user's text with no way back, so
    // the recognized wording is shown for confirmation first - and stays
    // editable, so a near-miss can be corrected instead of re-spoken.
    setSpokenCommand(finalCommand.trim())
  }, [audio])

  const toggleCommandRecording = useCallback(() => {
    if (phase === 'command-recording') {
      void stopCommandRecording()
    } else if (phase === 'ready' && displayText) {
      void startCommandRecording()
    }
  }, [phase, displayText, startCommandRecording, stopCommandRecording])

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
      // Streamed and phase-tracked for the same reason applyTransform is:
      // this is a full model rewrite of the transcript and can take seconds.
      // It used to run with neither, so the UI sat on 'ready' with the edit
      // bar still live - no progress, and nothing stopping a second edit
      // being fired at text the first one was still rewriting.
      setPhase('editing')
      const edited = await withStreamPreview((operationId) =>
        window.api.dictation.voiceEdit(displayText, command, operationId)
      )
      setDisplayText(edited)
      setPhase('ready')
      setSpokenCommand('')
      showReveal(diffWords(before, edited), VOICE_EDIT_REVEAL_MS)
      await persistCurrent({ displayText: edited })
    },
    [displayText, persistCurrent, showReveal, withStreamPreview]
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
    streamPreview,
    reveal,
    spokenCommand,
    toggleRecording,
    toggleCommandRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    loadFromHistory,
    startNew
  }
}
