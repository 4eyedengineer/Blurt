import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { Settings } from '../../shared/types'
import type { SettingsStore } from '../store/settingsStore'

function backendRelevantFieldsChanged(prev: Settings, next: Settings): boolean {
  return (
    prev.backend !== next.backend ||
    prev.modelId !== next.modelId ||
    JSON.stringify(prev.sidecar) !== JSON.stringify(next.sidecar)
  )
}

export function registerSettingsIpc(
  settingsStore: SettingsStore,
  applyHotkey: (accelerator: string) => boolean,
  /** Called (fire-and-forget from the caller's perspective) whenever a settings update touches backend/model/sidecar fields, so the active InferenceBackend can be hot-swapped. */
  onBackendSettingsChanged: () => void
): void {
  ipcMain.handle(IPC.settings.get, () => settingsStore.get())

  ipcMain.handle(IPC.settings.update, (_event, patch: Partial<Settings>) => {
    const prev = settingsStore.get()
    const next = settingsStore.update(patch)
    if (backendRelevantFieldsChanged(prev, next)) {
      onBackendSettingsChanged()
    }
    return next
  })

  ipcMain.handle(IPC.settings.addVocabularyWord, (_event, word: string) =>
    settingsStore.addVocabularyWord(word)
  )

  ipcMain.handle(IPC.settings.removeVocabularyWord, (_event, word: string) =>
    settingsStore.removeVocabularyWord(word)
  )

  ipcMain.handle(IPC.settings.updateHotkey, (_event, accelerator: string) => {
    const ok = applyHotkey(accelerator)
    if (ok) {
      settingsStore.update({ hotkey: accelerator })
    }
    return { ok }
  })
}
