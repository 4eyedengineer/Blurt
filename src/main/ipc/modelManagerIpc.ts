import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ModelId } from '../../shared/types'
import type { ModelManager } from '../backend/modelManager'

/** Wires the ModelManager (download/list/cancel/remove) up to IPC, forwarding progress events to the renderer for the Settings screen's progress bars. */
export function registerModelManagerIpc(
  modelManager: ModelManager,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC.models.list, () => ({
    installed: modelManager.listInstalled(),
    progress: modelManager.getAllProgress()
  }))

  ipcMain.handle(IPC.models.download, (_event, modelId: ModelId) => {
    // Fire-and-forget: progress/completion is reported via the 'progress' event.
    void modelManager.download(modelId)
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
