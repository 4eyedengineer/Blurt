import type { UseDictationSession } from '../hooks/useDictationSession'
import { RecordButton } from '../components/RecordButton'
import { TransformBar } from '../components/TransformBar'
import { StatsBar } from '../components/StatsBar'
import { VoiceEditBar } from '../components/VoiceEditBar'
import { MicLevelMeter } from '../components/MicLevelMeter'
import { CopyIcon } from '../components/Icons'
import { DiffReveal } from '../components/DiffReveal'
import './DictateScreen.css'

const STATUS_LABEL: Record<UseDictationSession['phase'], string> = {
  // idle has no status label - the transcript placeholder already tells the
  // user to press record, so a label here would just say the same thing twice.
  idle: '',
  recording: 'Listening…',
  finalizing: 'Finishing up…',
  cleaning: 'Cleaning up…',
  ready: 'Ready',
  transforming: 'Transforming…',
  'command-recording': 'Listening for an edit…',
  editing: 'Applying edit…'
}

export function DictateScreen({ session }: { session: UseDictationSession }): React.JSX.Element {
  const {
    phase,
    liveText,
    displayText,
    rawTranscript,
    displayMode,
    stats,
    copyFlash,
    sessionError,
    micLevel,
    streamPreview,
    reveal,
    spokenCommand,
    toggleRecording,
    toggleCommandRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    startNew
  } = session

  const recording = phase === 'recording'
  /** Capturing a spoken edit instruction - the mic is live, but the transcript is not being replaced. */
  const commandRecording = phase === 'command-recording'
  const streamingLive = phase === 'recording' || phase === 'finalizing'
  const rewriting = phase === 'cleaning' || phase === 'transforming' || phase === 'editing'
  const busy = rewriting || phase === 'finalizing'
  // While streaming (live audio, or a cleanup/transform/edit rewrite), render
  // updates immediately with no transition on the text itself - only the
  // shimmer/caret below are animated.
  const shownText = streamingLive
    ? liveText
    : phase === 'cleaning'
      ? streamPreview || rawTranscript
      : phase === 'transforming' || phase === 'editing'
        ? streamPreview || displayText
        : displayText
  const showCaret = streamingLive || rewriting
  const placeholder = recording ? 'Listening for speech…' : 'Press record to start dictating.'

  return (
    <section className="dictate-screen">
      <header className="dictate-screen__header">
        <div>
          <h1>Dictate</h1>
          {STATUS_LABEL[phase] && <p className="dictate-screen__status">{STATUS_LABEL[phase]}</p>}
        </div>
        {displayText && phase === 'ready' && (
          <button type="button" className="dictate-screen__new" onClick={startNew}>
            New dictation
          </button>
        )}
      </header>

      <div className="dictate-screen__record">
        {/* Disabled while a spoken edit is being captured: both share the one
            audio capture and session id, so starting a dictation mid-command
            would tear the command's session out from under it. */}
        <RecordButton
          recording={recording}
          disabled={busy || commandRecording}
          onToggle={toggleRecording}
        />
      </div>

      {/* Shown for a spoken edit too - it is the same microphone, and the
          same question of whether it is actually picking anything up. */}
      {(recording || commandRecording) && <MicLevelMeter level={micLevel} />}

      {sessionError && <p className="dictate-screen__warning">{sessionError}</p>}

      <div className="dictate-screen__transcript-wrap">
        <div className="dictate-screen__transcript-toolbar">
          <span>{recording ? 'Live transcript' : 'Transcript'}</span>
          <button
            type="button"
            className="dictate-screen__copy"
            disabled={!displayText || recording}
            onClick={() => void copyDisplayText()}
          >
            <CopyIcon width={16} height={16} />
            {copyFlash ? 'Copied!' : 'Copy'}
          </button>
        </div>
        <div
          className={[
            'dictate-screen__transcript',
            !shownText && !reveal && 'dictate-screen__transcript--empty',
            (phase === 'cleaning' || phase === 'transforming') &&
              !streamPreview &&
              'dictate-screen__transcript--busy'
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {reveal ? (
            <DiffReveal tokens={reveal} />
          ) : shownText ? (
            <>
              {shownText}
              {showCaret && <span className="stream-caret" aria-hidden="true" />}
            </>
          ) : (
            placeholder
          )}
        </div>
      </div>

      <TransformBar
        activeMode={displayMode}
        disabled={!displayText || recording || commandRecording}
        busy={busy}
        onTransform={(mode) => void applyTransform(mode)}
      />

      <VoiceEditBar
        disabled={!displayText || recording || busy}
        recording={commandRecording}
        spokenCommand={spokenCommand}
        onToggleRecording={toggleCommandRecording}
        onApply={(cmd) => void applyVoiceEdit(cmd)}
      />

      <StatsBar stats={stats} />
    </section>
  )
}
