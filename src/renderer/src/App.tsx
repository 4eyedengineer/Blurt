import { useState } from 'react'
import type { DictationEntry } from '@shared/types'
import { Sidebar, type TabId } from './components/Sidebar'
import { DictateScreen } from './screens/DictateScreen'
import { HistoryScreen } from './screens/HistoryScreen'
import { SettingsScreen } from './screens/SettingsScreen'
import { useDictationSession } from './hooks/useDictationSession'
import './App.css'

function App(): React.JSX.Element {
  const [tab, setTab] = useState<TabId>('dictate')
  const session = useDictationSession()

  const openHistoryEntry = (entry: DictationEntry): void => {
    session.loadFromHistory(entry)
    setTab('dictate')
  }

  return (
    <div className="app">
      <Sidebar active={tab} onSelect={setTab} />
      <main className="app__content">
        {tab === 'dictate' && <DictateScreen session={session} />}
        {tab === 'history' && <HistoryScreen onOpenEntry={openHistoryEntry} />}
        {tab === 'settings' && <SettingsScreen />}
      </main>
    </div>
  )
}

export default App
