import './Toggle.css'

interface ToggleProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
}

export function Toggle({ checked, onChange, label }: ToggleProps): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`toggle${checked ? ' toggle--on' : ''}`}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle__knob" />
    </button>
  )
}
