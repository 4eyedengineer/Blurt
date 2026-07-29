import { HistoryIcon, MicIcon, SettingsIcon } from './Icons'
import './Sidebar.css'

export type TabId = 'dictate' | 'history' | 'settings'

interface SidebarProps {
  active: TabId
  onSelect: (tab: TabId) => void
}

const TABS: Array<{ id: TabId; label: string; Icon: typeof MicIcon }> = [
  { id: 'dictate', label: 'Dictate', Icon: MicIcon },
  { id: 'history', label: 'History', Icon: HistoryIcon },
  { id: 'settings', label: 'Settings', Icon: SettingsIcon }
]

export function Sidebar({ active, onSelect }: SidebarProps): React.JSX.Element {
  return (
    <nav className="sidebar">
      <div className="sidebar__brand">
        <span className="sidebar__brand-dot" />
        Eloquent
      </div>
      <ul className="sidebar__list">
        {TABS.map(({ id, label, Icon }) => (
          <li key={id}>
            <button
              type="button"
              className={`sidebar__item${active === id ? ' sidebar__item--active' : ''}`}
              onClick={() => onSelect(id)}
            >
              <Icon />
              <span>{label}</span>
            </button>
          </li>
        ))}
      </ul>
    </nav>
  )
}
