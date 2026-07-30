import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ModelId } from '../../shared/types'
import type { ModelManager } from '../backend/modelManager'
import { resolveImportCli } from '../backend/sidecar'
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
    // doc) has to shell out to the litert-lm CLI, resolved from the managed
    // sidecar command (see resolveImportCli's doc comment for why that's
    // not simply "the managed command's first token") so the import lands
    // where `serve` will find it.
    const cliResolution = resolveImportCli(settingsStore.get().sidecar.managedCommand)
    // Fire-and-forget: progress/completion (including a resolution failure) is reported via the 'progress' event.
    void modelManager.download(modelId, cliResolution)
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
