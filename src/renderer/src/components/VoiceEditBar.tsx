import { useState } from 'react'
import { MicIcon, StopIcon } from './Icons'
import './VoiceEditBar.css'

interface VoiceEditBarProps {
  disabled?: boolean
  /** True while a spoken instruction is being captured - see DictationPhase 'command-recording'. */
  recording?: boolean
  /**
   * The spoken instruction as recognized so far, mirrored into the input as
   * the user speaks. Empty when nothing has been spoken, or once an edit has
   * been applied.
   */
  spokenCommand?: string
  /** Starts/stops capturing a spoken instruction. When omitted, the mic button is not rendered at all. */
  onToggleRecording?: () => void
  onApply: (command: string) => void
}

/**
 * The instruction bar: describe an edit ("replace foo with bar", "delete the
 * last sentence") and it is applied to the transcript.
 *
 * The instruction can be typed or spoken. Speaking runs through exactly the
 * same capture and transcription path as dictation itself, and the
 * recognized wording lands in this input rather than being applied straight
 * away - a misheard instruction rewrites the user's text with no way back,
 * so it is shown for confirmation, and stays editable so a near-miss can be
 * fixed by hand instead of re-spoken.
 */
export function VoiceEditBar({
  disabled,
  recording,
  spokenCommand,
  onToggleRecording,
  onApply
}: VoiceEditBarProps): React.JSX.Element {
  const [command, setCommand] = useState('')

  // Mirror recognized speech into the input, adjusting during render rather
  // than from an effect - the same "reset state when a prop changes" pattern
  // SettingsScreen uses to track settings.hotkey, and the reason this is not
  // a setState-in-effect. Keyed off the last value actually synced so that
  // an unrelated re-render can never overwrite what the user is typing, and
  // so clearing the command upstream does not wipe a fresh manual edit.
  // Seeded empty rather than from the prop, so a bar that mounts with a
  // command already recognized still shows it - seeding from the prop would
  // mark it as already synced and drop it on the floor.
  const [syncedSpoken, setSyncedSpoken] = useState('')
  const spoken = spokenCommand ?? ''
  if (spoken !== syncedSpoken) {
    setSyncedSpoken(spoken)
    if (spoken) setCommand(spoken)
  }

  const submit = (): void => {
    if (!command.trim()) return
    onApply(command.trim())
    setCommand('')
  }

  return (
    <div className="voice-edit-bar">
      <input
        type="text"
        placeholder='Voice edit command, e.g. "delete the last sentence"'
        value={command}
        // Stays typeable while recording, so a half-heard instruction can be
        // corrected without having to stop first.
        disabled={disabled && !recording}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      {onToggleRecording && (
        <button
          type="button"
          className={`voice-edit-bar__mic${recording ? ' voice-edit-bar__mic--recording' : ''}`}
          // The mic has to stay live while recording, or there would be no
          // way to stop; `disabled` only governs the idle state.
          disabled={disabled && !recording}
          onClick={onToggleRecording}
          aria-pressed={recording ?? false}
          aria-label={recording ? 'Stop listening' : 'Speak the edit instruction'}
          title={recording ? 'Stop listening' : 'Speak the edit instruction'}
        >
          {recording ? <StopIcon width={16} height={16} /> : <MicIcon width={16} height={16} />}
        </button>
      )}
      <button type="button" disabled={disabled || !command.trim()} onClick={submit}>
        Apply
      </button>
    </div>
  )
}
