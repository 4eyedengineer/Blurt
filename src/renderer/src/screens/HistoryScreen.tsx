import { useCallback, useEffect, useState } from 'react'
import type { DictationEntry } from '@shared/types'
import { formatTimestamp } from '../lib/format'
import { copyToClipboard } from '../lib/clipboard'
import { canRevertToCleaned } from '../lib/historyEntry'
import { CopyIcon, SearchIcon, TrashIcon } from '../components/Icons'
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

  const remove = useCallback(async (id: string) => {
    await window.api.history.remove(id)
    setEntries((prev) => prev.filter((entry) => entry.id !== id))
  }, [])

  const [copiedId, setCopiedId] = useState<string | null>(null)

  const copy = useCallback(async (entry: DictationEntry) => {
    const ok = await copyToClipboard(entry.displayText || entry.cleanedText)
    if (!ok) return
    setCopiedId(entry.id)
    // A different row's copy button can be clicked before this timer fires -
    // only clear the flash if this row is still the one showing it.
    setTimeout(() => setCopiedId((current) => (current === entry.id ? null : current)), 1500)
  }, [])

  // Restores the cleaned original - no model call, just writing back text
  // that is already stored. save() resolves with the updated row, which is
  // patched into local state directly (as `remove` above does) rather than
  // re-querying the whole store.
  const revert = useCallback(async (entry: DictationEntry) => {
    const updated = await window.api.history.save({
      id: entry.id,
      rawTranscript: entry.rawTranscript,
      cleanedText: entry.cleanedText,
      displayText: entry.cleanedText,
      displayMode: 'none',
      wordCount: entry.wordCount,
      durationMs: entry.durationMs,
      wpm: entry.wpm
    })
    setEntries((prev) => prev.map((e) => (e.id === updated.id ? updated : e)))
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
          <li key={entry.id} className="history-screen__item">
            {/* Spans, not <p>/<div>: a <button> may only contain phrasing
                content, so flow elements in here would be invalid markup.
                Both classes already set their own `display`, so this is
                purely a correctness change with no visual effect. */}
            <button
              type="button"
              className="history-screen__item-main"
              onClick={() => onOpenEntry(entry)}
            >
              <span className="history-screen__item-text">
                {entry.displayText || entry.cleanedText}
              </span>
              <span className="history-screen__item-meta">
                <span>{formatTimestamp(entry.createdAt)}</span>
                <span>{entry.wordCount} words</span>
                <span>{entry.wpm} wpm</span>
                {entry.displayMode !== 'none' && (
                  <span className="history-screen__badge">{entry.displayMode}</span>
                )}
              </span>
            </button>
            {/* Siblings of history-screen__item-main, never nested inside it -
                same reason as above, plus a <button> cannot itself contain
                another interactive element. Being siblings rather than
                descendants also means none of these need stopPropagation: a
                click here never bubbles through item-main's onClick (see the
                delete button, which lost its own stopPropagation call when
                the row's click handler moved off the <li> and onto
                item-main specifically). */}
            <div className="history-screen__actions">
              <button
                type="button"
                className={
                  copiedId === entry.id
                    ? 'history-screen__action history-screen__action--copied'
                    : 'history-screen__action'
                }
                aria-label="Copy dictation"
                onClick={() => void copy(entry)}
              >
                {copiedId === entry.id ? 'Copied' : <CopyIcon width={16} height={16} />}
              </button>
              {canRevertToCleaned(entry) && (
                <button
                  type="button"
                  className="history-screen__action"
                  aria-label="Revert to original"
                  title="Revert to the original cleaned text"
                  onClick={() => void revert(entry)}
                >
                  Revert
                </button>
              )}
              <button
                type="button"
                className="history-screen__action history-screen__delete"
                aria-label="Delete dictation"
                onClick={() => void remove(entry.id)}
              >
                <TrashIcon width={16} height={16} />
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  )
}
