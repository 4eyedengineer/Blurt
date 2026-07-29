import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ModelId } from '../../shared/types'
import type { ModelManager } from '../backend/modelManager'
import { getManagedCommandBinary } from '../backend/sidecar'
import type { SettingsStore } from '../store/settingsStore'

/** Wires the ModelManager (download/list/cancel/remove) up to IPC, forwarding progress events to the renderer for the Settings screen's progress bars. */
export function registerModelManagerIpc(
  modelManager: ModelManager,
  settingsStore: SettingsStore,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC.models.list, () => ({
    installed: modelManager.listInstalled(),
    progress: modelManager.getAllProgress()
  }))

  ipcMain.handle(IPC.models.download, (_event, modelId: ModelId) => {
    // The download's final `litert-lm import` step (see ModelManager class
    // doc) has to shell out to the same `litert-lm` binary the managed
    // sidecar command uses, so the import lands where `serve` will find it.
    const cliBinary = getManagedCommandBinary(settingsStore.get().sidecar.managedCommand)
    // Fire-and-forget: progress/completion is reported via the 'progress' event.
    void modelManager.download(modelId, cliBinary)
  })

  ipcMain.handle(IPC.models.cancelDownload, (_event, modelId: ModelId) => {
    modelManager.cancelDownload(modelId)
  })

  ipcMain.handle(IPC.models.remove, (_event, modelId: ModelId) => {
    modelManager.remove(modelId)
  })

  modelManager.on('progress', (progress) => {
    getWindow()?.webContents.send(IPC.models.progress, progress)
  })
}
