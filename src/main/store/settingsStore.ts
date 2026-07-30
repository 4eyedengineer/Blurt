import { join } from 'path'
import {
  CURRENT_SETTINGS_VERSION,
  DEFAULT_SETTINGS,
  MANAGED_COMMAND_BY_ACCELERATOR,
  type Settings
} from '../../shared/types'
import { JsonStore } from './jsonStore'

export class SettingsStore {
  private store: JsonStore<Settings>

  constructor(userDataDir: string) {
    this.store = new JsonStore<Settings>(join(userDataDir, 'settings.json'), DEFAULT_SETTINGS)
    this.migrate()
  }

  /**
   * One-time rewrites for settings.json files written by an older version
   * of the app - see `CURRENT_SETTINGS_VERSION`'s doc comment for what each
   * step does and why. No-ops (and writes nothing) once `settingsVersion`
   * is already current, so this is cheap to call unconditionally on every
   * startup.
   */
  private migrate(): void {
    const current = this.store.read()
    const fromVersion = current.settingsVersion ?? 0
    if (fromVersion >= CURRENT_SETTINGS_VERSION) return

    let next = current
    if (fromVersion < 1) {
      const hadUnmodifiedCpuTemplate =
        current.sidecar.managedCommand === MANAGED_COMMAND_BY_ACCELERATOR.cpu
      next = {
        ...next,
        sidecar: {
          ...next.sidecar,
          accelerator: 'gpu',
          managedCommand: hadUnmodifiedCpuTemplate
            ? MANAGED_COMMAND_BY_ACCELERATOR.gpu
            : next.sidecar.managedCommand
        }
      }
    }
    this.store.write({ ...next, settingsVersion: CURRENT_SETTINGS_VERSION })
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
