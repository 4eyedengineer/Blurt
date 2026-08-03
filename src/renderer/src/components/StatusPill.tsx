import type { BackendStatus } from '@shared/backend'
import './StatusPill.css'

const LABELS: Record<BackendStatus['state'], string> = {
  starting: 'Starting…',
  ready: 'Ready',
  error: 'Error'
}

/** Only appended once the sidecar's engine truthfully reports its backend (see BackendStatus.effectiveAccelerator) - never guessed from the requested setting. */
function acceleratorSuffix(status: BackendStatus): string {
  return status.state === 'ready' && status.effectiveAccelerator
    ? ` · ${status.effectiveAccelerator.toUpperCase()}`
    : ''
}

export function StatusPill({ status }: { status: BackendStatus }): React.JSX.Element {
  const label = `${LABELS[status.state]}${acceleratorSuffix(status)}`
  // The engine's own words on hover, the short reason otherwise. This is the
  // one place `detail` is reachable from the UI at all - everywhere else
  // shows `message` (see BackendStatus), so a hover is the escape hatch for
  // anyone actually debugging rather than something every user is shown.
  const title = status.detail ?? status.message ?? label
  return (
    <div className={`status-pill status-pill--${status.state}`} title={title}>
      <span className="status-pill__dot" />
      <span className="status-pill__label">{label}</span>
    </div>
  )
}
