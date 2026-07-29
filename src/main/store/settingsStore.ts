import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { JsonStore } from './jsonStore'

export class SettingsStore {
  private store: JsonStore<Settings>

  constructor(userDataDir: string) {
    this.store = new JsonStore<Settings>(join(userDataDir, 'settings.json'), DEFAULT_SETTINGS)
  }

  get(): Settings {
    return this.store.read()
  }

  update(patch: Partial<Settings>): Settings {
    const next = { ...this.store.read(), ...patch }
    this.store.write(next)
    return next
  }

  addVocabularyWord(word: string): Settings {
    const trimmed = word.trim()
    if (!trimmed) return this.get()
    const current = this.get()
    if (current.customVocabulary.some((w) => w.toLowerCase() === trimmed.toLowerCase())) {
      return current
    }
    return this.update({ customVocabulary: [...current.customVocabulary, trimmed] })
  }

  removeVocabularyWord(word: string): Settings {
    const current = this.get()
    return this.update({
      customVocabulary: current.customVocabulary.filter(
        (w) => w.toLowerCase() !== word.toLowerCase()
      )
    })
  }
}
