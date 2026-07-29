import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { Settings } from '../../shared/types'
import type { SettingsStore } from '../store/settingsStore'

export function registerSettingsIpc(
  settingsStore: SettingsStore,
  applyHotkey: (accelerator: string) => boolean
): void {
  ipcMain.handle(IPC.settings.get, () => settingsStore.get())

  ipcMain.handle(IPC.settings.update, (_event, patch: Partial<Settings>) =>
    settingsStore.update(patch)
  )

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
