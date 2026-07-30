import { join } from 'path'
import { DEFAULT_SETTINGS, type Settings } from '../../shared/types'
import { JsonStore } from './jsonStore'
import { log } from '../log'

export class SettingsStore {
  private store: JsonStore<Settings>
  /** Guards the legacy-`backend` log below to once per process, not once per `get()` call. */
  private warnedLegacyBackend = false

  constructor(userDataDir: string) {
    this.store = new JsonStore<Settings>(join(userDataDir, 'settings.json'), DEFAULT_SETTINGS)
  }

  get(): Settings {
    const settings = this.store.read()
    // `Settings.backend` was removed (the mock backend is gone - litert is
    // the only implementation now, so a distinct setting was meaningless).
    // An older settings.json can still have this key (most commonly
    // `"backend": "mock"`, from before this change) sitting unused in the
    // parsed object (JsonStore merges unknown keys straight through) -
    // rather than silently ignoring it, log once so it's visible that a
    // legacy value is present and being treated as litert.
    if (!this.warnedLegacyBackend) {
      const legacyBackend = (settings as Partial<Settings> & { backend?: unknown }).backend
      if (legacyBackend !== undefined && legacyBackend !== 'litert') {
        log.warn(
          `settings: ignoring legacy 'backend' value ${JSON.stringify(legacyBackend)} from settings.json (the mock backend was removed - litert is now the only backend)`
        )
      }
      this.warnedLegacyBackend = true
    }
    return settings
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
