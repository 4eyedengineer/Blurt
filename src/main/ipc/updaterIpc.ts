import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { UpdateController } from '../updater'

/**
 * Wires the UpdateController up to IPC so Settings can show what the updater
 * is actually doing and offer the restart when there is something to install.
 *
 * Status is pushed to the main window only, not the overlay: the overlay is a
 * transient push-to-talk pill with no room for this and no business showing
 * it mid-dictation.
 */
export function registerUpdaterIpc(
  updater: UpdateController,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC.update.getStatus, () => updater.getStatus())
  ipcMain.handle(IPC.update.restartToInstall, () => updater.restartToInstall())

  updater.on('status', (status) => {
    const window = getWindow()
    if (window && !window.isDestroyed()) {
      window.webContents.send(IPC.update.statusChanged, status)
    }
  })
}
