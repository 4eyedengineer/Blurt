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
  idle: 'Tap to start dictating',
  recording: 'Listening…',
  finalizing: 'Finishing up…',
  cleaning: 'Cleaning up…',
  ready: 'Ready',
  transforming: 'Transforming…'
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
    toggleRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    startNew
  } = session

  const recording = phase === 'recording'
  const streamingLive = phase === 'recording' || phase === 'finalizing'
  const busy = phase === 'cleaning' || phase === 'transforming' || phase === 'finalizing'
  // While streaming (live audio, or a cleanup/transform rewrite), render
  // updates immediately with no transition on the text itself - only the
  // shimmer/caret below are animated.
  const shownText = streamingLive
    ? liveText
    : phase === 'cleaning'
      ? streamPreview || rawTranscript
      : phase === 'transforming'
        ? streamPreview || displayText
        : displayText
  const showCaret = streamingLive || phase === 'cleaning' || phase === 'transforming'
  const placeholder = recording
    ? 'Listening for speech…'
    : 'Your dictation will appear here. Press the microphone to begin.'

  return (
    <section className="dictate-screen">
      <header className="dictate-screen__header">
        <div>
          <h1>Dictate</h1>
          <p className="dictate-screen__status">{STATUS_LABEL[phase]}</p>
        </div>
        {displayText && phase === 'ready' && (
          <button type="button" className="dictate-screen__new" onClick={startNew}>
            New dictation
          </button>
        )}
      </header>

      <div className="dictate-screen__record">
        <RecordButton recording={recording} disabled={busy} onToggle={toggleRecording} />
      </div>

      {recording && <MicLevelMeter level={micLevel} />}

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
        disabled={!displayText || recording}
        busy={busy}
        onTransform={(mode) => void applyTransform(mode)}
      />

      <VoiceEditBar
        disabled={!displayText || recording || busy}
        onApply={(cmd) => void applyVoiceEdit(cmd)}
      />

      <StatsBar stats={stats} />
    </section>
  )
}
