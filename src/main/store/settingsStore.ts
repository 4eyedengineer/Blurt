import { join } from 'path'
import {
  DEFAULT_PUSH_TO_TALK_SETTINGS,
  DEFAULT_SETTINGS,
  DEFAULT_SIDECAR_SETTINGS,
  type Settings
} from '../../shared/types'
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
    // JsonStore fills in missing defaults one level deep only, so a nested
    // object present in settings.json replaces its default wholesale. Every
    // key added to `pushToTalk` or `sidecar` after a user's settings.json was
    // written therefore arrives as `undefined` for exactly the people who
    // have been using Blurt longest, while reading correctly on a fresh
    // install - so a new boolean silently defaults to off for them no matter
    // what DEFAULT_SETTINGS says.
    //
    // Filling the gaps here rather than rewriting settings.json: the user's
    // own values still win (they are spread last), nothing on disk is
    // touched, and a key they never set is simply treated as unset.
    return {
      ...settings,
      sidecar: { ...DEFAULT_SIDECAR_SETTINGS, ...settings.sidecar },
      pushToTalk: { ...DEFAULT_PUSH_TO_TALK_SETTINGS, ...settings.pushToTalk }
    }
  }

  update(patch: Partial<Settings>): Settings {
    // Via get(), not the raw store, so a write never persists a nested
    // object still missing the defaults get() just filled in.
    const next = { ...this.get(), ...patch }
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
