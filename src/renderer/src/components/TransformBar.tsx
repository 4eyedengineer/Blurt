import type { TransformMode } from '@shared/backend'
import type { DictationDisplayMode } from '@shared/types'
import './TransformBar.css'

interface TransformBarProps {
  activeMode: DictationDisplayMode
  disabled?: boolean
  busy?: boolean
  onTransform: (mode: TransformMode) => void
}

const OPTIONS: Array<{ id: TransformMode; label: string }> = [
  { id: 'keypoints', label: 'Key Points' },
  { id: 'formal', label: 'Formal' },
  { id: 'short', label: 'Short' },
  { id: 'long', label: 'Long' }
]

export function TransformBar({
  activeMode,
  disabled,
  busy,
  onTransform
}: TransformBarProps): React.JSX.Element {
  return (
    <div className="transform-bar">
      {OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`transform-bar__chip${activeMode === opt.id ? ' transform-bar__chip--active' : ''}`}
          disabled={disabled || busy}
          onClick={() => onTransform(opt.id)}
        >
          {opt.label}
        </button>
      ))}
    </div>
  )
}
