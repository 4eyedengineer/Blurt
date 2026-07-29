import type { BrowserWindow, IpcMain } from 'electron'
import { clipboard } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { SettingsStore } from './store/settingsStore'
import type { PushToTalkController } from './pushToTalk/pushToTalkController'
import { showOverlayWindow } from './overlay'
import { copyAndPaste } from './paste'

const AUTO_HIDE_MS = 2500
/** Accidental taps get a much shorter grace period since there's nothing for the user to read. */
const CANCEL_HIDE_MS = 350

interface OverlayResultPayload {
  rawTranscript: string
  cleanedText: string
}

/**
 * The state machine that turns PushToTalkController's hold-start/hold-end/
 * accidental-tap events into overlay-window IPC. Deliberately thin: the
 * actual dictation session (startSession/pushAudio/endSession/cleanup) is
 * driven by the *overlay renderer itself* over the same
 * `window.api.dictation.*` bridge the main Dictate screen uses (see
 * src/renderer/src/overlay/useOverlayPushToTalk.ts) - this class only shows/
 * hides the window and tells the renderer when to start/stop, then handles
 * clipboard + paste injection once the renderer reports a cleaned result
 * back over IPC.overlay.result.
 */
export class OverlayController {
  private hideTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly pushToTalk: PushToTalkController,
    private readonly getOverlayWindow: () => BrowserWindow | null,
    private readonly settingsStore: SettingsStore,
    ipcMain: IpcMain
  ) {
    this.pushToTalk.on('hold-start', () => this.handleHoldStart())
    this.pushToTalk.on('hold-end', () => this.handleHoldEnd())
    this.pushToTalk.on('accidental-tap', () => this.handleAccidentalTap())

    ipcMain.on(IPC.overlay.result, (_event, payload: OverlayResultPayload) => {
      void this.handleResult(payload)
    })
  }

  private send(channel: string, ...args: unknown[]): void {
    const window = this.getOverlayWindow()
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }

  private clearHideTimer(): void {
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
  }

  private handleHoldStart(): void {
    this.clearHideTimer()
    const window = this.getOverlayWindow()
    if (window) showOverlayWindow(window)
    this.send(IPC.overlay.pttStart)
  }

  private handleHoldEnd(): void {
    this.send(IPC.overlay.pttStop)
  }

  private handleAccidentalTap(): void {
    this.send(IPC.overlay.pttCancel)
    this.scheduleHide(CANCEL_HIDE_MS)
  }

  private async handleResult(payload: OverlayResultPayload): Promise<void> {
    const { autoPaste } = this.settingsStore.get().pushToTalk
    const outcome = await copyAndPaste(clipboard, payload.cleanedText, autoPaste)
    this.send(IPC.overlay.pasteStatus, outcome)
    this.scheduleHide(AUTO_HIDE_MS)
  }

  private scheduleHide(ms: number): void {
    this.clearHideTimer()
    this.hideTimer = setTimeout(() => {
      this.getOverlayWindow()?.hide()
      this.send(IPC.overlay.reset)
      this.hideTimer = null
    }, ms)
  }
}
