import { useCallback, useEffect, useState } from 'react'
import type { DictationEntry } from '@shared/types'
import { formatTimestamp } from '../lib/format'
import { SearchIcon, TrashIcon } from '../components/Icons'
import './HistoryScreen.css'

interface HistoryScreenProps {
  onOpenEntry: (entry: DictationEntry) => void
}

export function HistoryScreen({ onOpenEntry }: HistoryScreenProps): React.JSX.Element {
  const [entries, setEntries] = useState<DictationEntry[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (q: string) => {
    const result = q.trim() ? await window.api.history.search(q) : await window.api.history.list()
    setEntries(result)
    setLoading(false)
  }, [])

  useEffect(() => {
    const handle = setTimeout(() => {
      void refresh(query)
    }, 150)
    return () => clearTimeout(handle)
  }, [query, refresh])

  // Push-to-talk dictations are written by the main process, not this
  // window - without this, a dictation made while the History screen is
  // open wouldn't appear until the user navigated away and back.
  useEffect(() => {
    return window.api.history.onChanged(() => void refresh(query))
  }, [query, refresh])

  const remove = useCallback(async (id: string, event: React.MouseEvent) => {
    event.stopPropagation()
    await window.api.history.remove(id)
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
  }, [])

  return (
    <section className="history-screen">
      <header className="history-screen__header">
        <h1>History</h1>
        <div className="history-screen__search">
          <SearchIcon width={16} height={16} />
          <input
            type="text"
            placeholder="Search dictations…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </header>

      {!loading && entries.length === 0 && (
        <p className="history-screen__empty">
          {query
            ? 'No dictations match your search.'
            : 'No dictations yet - start recording to build history.'}
        </p>
      )}

      <ul className="history-screen__list">
        {entries.map((entry) => (
          <li key={entry.id} className="history-screen__item" onClick={() => onOpenEntry(entry)}>
            <div className="history-screen__item-main">
              <p className="history-screen__item-text">{entry.displayText || entry.cleanedText}</p>
              <div className="history-screen__item-meta">
                <span>{formatTimestamp(entry.createdAt)}</span>
                <span>{entry.wordCount} words</span>
                <span>{entry.wpm} wpm</span>
                {entry.displayMode !== 'none' && (
                  <span className="history-screen__badge">{entry.displayMode}</span>
                )}
              </div>
            </div>
            <button
              type="button"
              className="history-screen__delete"
              aria-label="Delete dictation"
              onClick={(e) => void remove(entry.id, e)}
            >
              <TrashIcon width={16} height={16} />
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}
