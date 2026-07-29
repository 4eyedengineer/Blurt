import type { SessionStats } from '../lib/format'
import { formatDuration } from '../lib/format'
import './StatsBar.css'

export function StatsBar({ stats }: { stats: SessionStats | null }): React.JSX.Element | null {
  if (!stats) return null
  return (
    <div className="stats-bar">
      <div className="stats-bar__item">
        <span className="stats-bar__value">{stats.wordCount}</span>
        <span className="stats-bar__label">words</span>
      </div>
      <div className="stats-bar__divider" />
      <div className="stats-bar__item">
        <span className="stats-bar__value">{stats.wpm}</span>
        <span className="stats-bar__label">wpm</span>
      </div>
      <div className="stats-bar__divider" />
      <div className="stats-bar__item">
        <span className="stats-bar__value">{formatDuration(stats.durationMs)}</span>
        <span className="stats-bar__label">duration</span>
      </div>
    </div>
  )
}
