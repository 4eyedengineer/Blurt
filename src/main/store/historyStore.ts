import { randomUUID } from 'crypto'
import { join } from 'path'
import type { DictationEntry, NewDictationEntry } from '../../shared/types'
import { JsonStore } from './jsonStore'

export class HistoryStore {
  private store: JsonStore<DictationEntry[]>

  constructor(userDataDir: string) {
    this.store = new JsonStore<DictationEntry[]>(join(userDataDir, 'history.json'), [])
  }

  list(): DictationEntry[] {
    return [...this.store.read()].sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): DictationEntry | null {
    return this.store.read().find((e) => e.id === id) ?? null
  }

  search(query: string): DictationEntry[] {
    const q = query.trim().toLowerCase()
    if (!q) return this.list()
    return this.list().filter(
      (e) =>
        e.rawTranscript.toLowerCase().includes(q) ||
        e.cleanedText.toLowerCase().includes(q) ||
        e.displayText.toLowerCase().includes(q)
    )
  }

  /** Creates a new entry, or updates an existing one if `id` is provided. */
  save(entry: NewDictationEntry & { id?: string }): DictationEntry {
    const all = this.store.read()
    if (entry.id) {
      const idx = all.findIndex((e) => e.id === entry.id)
      if (idx !== -1) {
        const updated: DictationEntry = { ...all[idx], ...entry, id: all[idx].id }
        const next = [...all]
        next[idx] = updated
        this.store.write(next)
        return updated
      }
    }
    const created: DictationEntry = { ...entry, id: randomUUID(), createdAt: Date.now() }
    this.store.write([...all, created])
    return created
  }

  remove(id: string): void {
    this.store.write(this.store.read().filter((e) => e.id !== id))
  }
}
