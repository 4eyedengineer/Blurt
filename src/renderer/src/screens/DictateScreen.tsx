import type { UseDictationSession } from '../hooks/useDictationSession'
import { RecordButton } from '../components/RecordButton'
import { TransformBar } from '../components/TransformBar'
import { StatsBar } from '../components/StatsBar'
import { VoiceEditBar } from '../components/VoiceEditBar'
import { MicLevelMeter } from '../components/MicLevelMeter'
import { CopyIcon } from '../components/Icons'
import './DictateScreen.css'

const STATUS_LABEL: Record<UseDictationSession['phase'], string> = {
  idle: 'Tap to start dictating',
  recording: 'Listening…',
  cleaning: 'Cleaning up…',
  ready: 'Ready',
  transforming: 'Transforming…'
}

export function DictateScreen({ session }: { session: UseDictationSession }): React.JSX.Element {
  const {
    phase,
    liveText,
    displayText,
    displayMode,
    stats,
    copyFlash,
    audioWarning,
    sessionError,
    micLevel,
    noAudioDetected,
    toggleRecording,
    applyTransform,
    applyVoiceEdit,
    copyDisplayText,
    startNew
  } = session

  const recording = phase === 'recording'
  const busy = phase === 'cleaning' || phase === 'transforming'
  const shownText = recording ? liveText : displayText
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
        <RecordButton
          recording={recording}
          disabled={phase === 'cleaning'}
          onToggle={toggleRecording}
        />
      </div>

      {recording && <MicLevelMeter level={micLevel} />}

      {audioWarning && <p className="dictate-screen__warning">{audioWarning}</p>}
      {!audioWarning && recording && noAudioDetected && (
        <p className="dictate-screen__warning">
          No audio detected from microphone - check that the correct input device is selected and
          unmuted.
        </p>
      )}
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
          className={`dictate-screen__transcript${shownText ? '' : ' dictate-screen__transcript--empty'}`}
        >
          {shownText || placeholder}
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
