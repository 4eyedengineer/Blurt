import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { PushToTalkSettings, Settings } from '../../shared/types'
import type { SettingsStore } from '../store/settingsStore'

function backendRelevantFieldsChanged(prev: Settings, next: Settings): boolean {
  return (
    prev.modelId !== next.modelId || JSON.stringify(prev.sidecar) !== JSON.stringify(next.sidecar)
  )
}

function pushToTalkSettingsChanged(prev: Settings, next: Settings): boolean {
  return JSON.stringify(prev.pushToTalk) !== JSON.stringify(next.pushToTalk)
}

export function registerSettingsIpc(
  settingsStore: SettingsStore,
  applyHotkey: (accelerator: string) => boolean,
  /** Called (fire-and-forget from the caller's perspective) whenever a settings update touches backend/model/sidecar fields, so the active InferenceBackend can be hot-swapped. */
  onBackendSettingsChanged: () => void,
  /** Called whenever a settings update touches `pushToTalk`, so PushToTalkController can start/stop its OS-level hook or switch keys. */
  onPushToTalkSettingsChanged: (settings: PushToTalkSettings) => void
): void {
  ipcMain.handle(IPC.settings.get, () => settingsStore.get())

  ipcMain.handle(IPC.settings.update, (_event, patch: Partial<Settings>) => {
    const prev = settingsStore.get()
    const next = settingsStore.update(patch)
    if (backendRelevantFieldsChanged(prev, next)) {
      onBackendSettingsChanged()
    }
    if (pushToTalkSettingsChanged(prev, next)) {
      onPushToTalkSettingsChanged(next.pushToTalk)
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
