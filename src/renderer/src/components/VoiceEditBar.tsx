import { useState } from 'react'
import './VoiceEditBar.css'

interface VoiceEditBarProps {
  disabled?: boolean
  onApply: (command: string) => void
}

/**
 * A small text-command box that exercises InferenceBackend.voiceEdit.
 * Stands in for what would eventually be a literal spoken command (e.g.
 * "delete the last sentence", "replace foo with bar") once the real
 * backend can interpret free-form instructions.
 */
export function VoiceEditBar({ disabled, onApply }: VoiceEditBarProps): React.JSX.Element {
  const [command, setCommand] = useState('')

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
        disabled={disabled}
        onChange={(e) => setCommand(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button type="button" disabled={disabled || !command.trim()} onClick={submit}>
        Apply
      </button>
    </div>
  )
}
