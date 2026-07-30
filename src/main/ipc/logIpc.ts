import { ipcMain, shell } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import { getLogsDir, log } from '../log'

/** Renderer-side failures (audio capture) have no main-process log call site of their own - this is the one IPC hop for them. */
export function registerLogIpc(userDataDir: string): void {
  ipcMain.on(IPC.log.rendererError, (_event, line: string) => {
    log.error(`renderer: ${line}`)
  })

  ipcMain.handle(IPC.log.openFolder, () => {
    void shell.openPath(getLogsDir(userDataDir))
  })
}
