import { ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { PushToTalkStatus } from '../../shared/types'
import type { PushToTalkController } from '../pushToTalk/pushToTalkController'
import { checkXdotoolAvailable } from '../paste'
import { detectWSLReal } from '../wsl'

export function registerPushToTalkIpc(controller: PushToTalkController): void {
  ipcMain.handle(IPC.pushToTalk.getStatus, async (): Promise<PushToTalkStatus> => {
    const availability = controller.getAvailability()
    return {
      available: availability.available,
      reason: availability.reason,
      platform: process.platform,
      isWSL: detectWSLReal(),
      xdotoolAvailable: process.platform === 'linux' ? await checkXdotoolAvailable() : null
    }
  })
}
