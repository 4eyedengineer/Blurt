import type { BackendStatus } from '@shared/backend'
import './StatusPill.css'

const LABELS: Record<BackendStatus['state'], string> = {
  mock: 'Mock backend',
  starting: 'Starting…',
  ready: 'LiteRT-LM ready',
  error: 'Backend error'
}

export function StatusPill({ status }: { status: BackendStatus }): React.JSX.Element {
  const title = status.message ?? LABELS[status.state]
  return (
    <div className={`status-pill status-pill--${status.state}`} title={title}>
      <span className="status-pill__dot" />
      <span className="status-pill__label">{LABELS[status.state]}</span>
    </div>
  )
}
