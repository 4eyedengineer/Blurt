import './MicLevelMeter.css'

export interface MicLevelMeterProps {
  /** Normalized 0-1 mic input level (see useAudioCapture's `level`). */
  level: number
}

/**
 * Small live bar meter driven by the RMS of the PCM chunks already flowing
 * through useAudioCapture - gives the user an at-a-glance signal that the
 * mic is actually delivering audio (as opposed to the silent/empty buffer
 * that causes LitertBackend to hallucinate a transcript - see its
 * 'no_audio' guard).
 */
export function MicLevelMeter({ level }: MicLevelMeterProps): React.JSX.Element {
  // Boost visually - typical speech RMS is a small fraction of full scale,
  // so a raw 1:1 mapping would look flat even with a healthy signal.
  const pct = Math.max(2, Math.min(100, level * 100 * 5))
  return (
    <div
      className="mic-level-meter"
      role="meter"
      aria-label="Microphone input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(pct)}
    >
      <div className="mic-level-meter__fill" style={{ width: `${pct}%` }} />
    </div>
  )
}
