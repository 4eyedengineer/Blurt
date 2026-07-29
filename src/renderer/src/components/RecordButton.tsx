import { MicIcon, StopIcon } from './Icons'
import './RecordButton.css'

interface RecordButtonProps {
  recording: boolean
  disabled?: boolean
  onToggle: () => void
}

export function RecordButton({
  recording,
  disabled,
  onToggle
}: RecordButtonProps): React.JSX.Element {
  return (
    <button
      type="button"
      className={`record-button${recording ? ' record-button--active' : ''}`}
      onClick={onToggle}
      disabled={disabled}
      aria-pressed={recording}
      aria-label={recording ? 'Stop recording' : 'Start recording'}
    >
      <span className="record-button__ring" />
      {recording ? <StopIcon width={32} height={32} /> : <MicIcon width={32} height={32} />}
    </button>
  )
}
