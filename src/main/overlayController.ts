import type { BrowserWindow, IpcMain } from 'electron'
import { clipboard } from 'electron'
import { IPC } from '../shared/ipc-channels'
import type { SettingsStore } from './store/settingsStore'
import type { PushToTalkController } from './pushToTalk/pushToTalkController'
import { showOverlayWindow } from './overlay'
import { copyAndPaste } from './paste'
import { log } from './log'
import { computeStats } from '../shared/stats'
import type { HistoryStore } from './store/historyStore'

const AUTO_HIDE_MS = 2500
/** Accidental taps get a much shorter grace period since there's nothing for the user to read. */
const CANCEL_HIDE_MS = 350
/**
 * Hard ceiling on how long the pill may stay up after the key is released
 * while waiting for the renderer's result. The renderer always reports back
 * (success *or* failure - see useOverlayPushToTalk.stop's finally), so this
 * only fires if a transcription/cleanup request never settles at all (a hung
 * sidecar). Without it, that hangs the pill on screen permanently with no
 * way to dismiss it - which is exactly what a user hit. Logged when it
 * fires, since it always means something upstream never finished.
 */
const STUCK_HIDE_MS = 30_000

interface OverlayResultPayload {
  rawTranscript: string
  cleanedText: string
  /** Measured from the first captured PCM chunk, not the keypress - see useOverlayPushToTalk. */
  durationMs: number
  /** Set instead of the text fields when the overlay's own dictation session failed - see useOverlayPushToTalk.stop. */
  error?: string
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
    /** Overlay dictations land in the same history as the Dictate screen's - see `recordHistory`. */
    private readonly historyStore: HistoryStore,
    /** Notifies the main window that history changed, so an open History screen re-reads it. */
    private readonly notifyHistoryChanged: () => void,
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
    this.scheduleHide(STUCK_HIDE_MS)
  }

  private handleAccidentalTap(): void {
    this.send(IPC.overlay.pttCancel)
    this.scheduleHide(CANCEL_HIDE_MS)
  }

  private async handleResult(payload: OverlayResultPayload): Promise<void> {
    if (payload.error) {
      log.error(`overlay: dictation failed: ${payload.error}`)
      this.scheduleHide(AUTO_HIDE_MS)
      return
    }
    const { autoPaste } = this.settingsStore.get().pushToTalk
    const outcome = await copyAndPaste(clipboard, payload.cleanedText, autoPaste)
    this.send(IPC.overlay.pasteStatus, outcome)
    this.recordHistory(payload)
    this.scheduleHide(AUTO_HIDE_MS)
  }

  /**
   * Files an overlay dictation into the same history the Dictate screen
   * writes to - a dictation is a dictation regardless of which surface
   * captured it. Empty results are skipped (nothing was said; a blank row
   * is noise, not history). Never throws: a history-write failure must not
   * cost the user the clipboard/paste that already succeeded above.
   */
  private recordHistory(payload: OverlayResultPayload): void {
    if (!payload.cleanedText.trim()) return
    try {
      const stats = computeStats(payload.cleanedText, payload.durationMs)
      this.historyStore.save({
        rawTranscript: payload.rawTranscript,
        cleanedText: payload.cleanedText,
        displayText: payload.cleanedText,
        displayMode: 'none',
        wordCount: stats.wordCount,
        durationMs: stats.durationMs,
        wpm: stats.wpm
      })
      // The History screen may already be open and listing stale rows -
      // tell it to re-read rather than making the user navigate away and
      // back to see what they just dictated.
      this.notifyHistoryChanged()
    } catch (err) {
      log.error(
        `overlay: failed to save dictation to history: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }

  private scheduleHide(ms: number): void {
    this.clearHideTimer()
    this.hideTimer = setTimeout(() => {
      if (ms === STUCK_HIDE_MS) {
        log.warn(`overlay: no result ${STUCK_HIDE_MS}ms after key release - hiding anyway`)
      }
      this.getOverlayWindow()?.hide()
      this.send(IPC.overlay.reset)
      this.hideTimer = null
    }, ms)
  }
}
