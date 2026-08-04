import { EventEmitter } from 'events'
import { autoUpdater } from 'electron-updater'
import { describeUpdateSupport, type UpdateStatus } from '../shared/updater'
import { log } from './log'

/**
 * How often to re-check after the first check at startup.
 *
 * Blurt is not an app people relaunch. It lives in the tray so the
 * push-to-talk hook stays armed, and a machine that is never rebooted can run
 * one process for weeks - so a check-on-startup-only policy would mean a user
 * sitting on a stale build indefinitely, which is exactly the case
 * self-update exists for. Six hours is frequent enough that an update lands
 * the same day it ships and rare enough to be invisible.
 */
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

export interface UpdateControllerDeps {
  platform: NodeJS.Platform
  /** `app.isPackaged`. */
  isPackaged: boolean
}

/**
 * Owns Blurt's self-update: asks GitHub Releases whether a newer version
 * exists, downloads it in the background, and reports honestly what state
 * that is in. Emits 'status' (UpdateStatus) on every change.
 *
 * Two deliberate choices about *when* an update actually gets applied:
 *
 *  - `autoInstallOnAppQuit` (electron-updater's default) is left on, so a
 *    downloaded update installs during a normal quit with nothing asked of
 *    the user.
 *  - Nothing here ever restarts the app on its own. Blurt can be mid-dictation
 *    at any moment with no window on screen, and an unprompted restart would
 *    kill the sidecar with the user's words still in it. `restartToInstall`
 *    exists, but only the user can trigger it, and the Settings screen only
 *    offers it while the session is idle.
 *
 * The Python sidecar needs no special handling here, which is worth stating
 * because it looks like it should. `quitAndInstall` spawns the NSIS installer
 * and then calls `app.quit()`; the moment this process dies, the sidecar's
 * own parent watchdog (`BLURT_PARENT_PID`, see resources/serve_gpu.py) wakes
 * on a real OS wait and exits, releasing the DLLs it had mapped out of the
 * install directory well before the installer reaches them.
 */
export class UpdateController extends EventEmitter {
  private status: UpdateStatus
  private checkTimer: ReturnType<typeof setInterval> | null = null
  /** Carried across events so a 'download-progress' tick (which knows only bytes) can still name the version it is fetching. */
  private pendingVersion: string | undefined

  constructor(deps: UpdateControllerDeps) {
    super()
    const support = describeUpdateSupport(deps)
    if (!support.supported) {
      this.status = { state: 'unsupported', detail: support.reason }
      log.info(`updater: self-update unavailable - ${support.reason}`)
      return
    }
    // 'checking' rather than 'idle' as the opening state: `start()` runs a
    // check immediately, and 'idle' is rendered as "Blurt is up to date",
    // which would be a claim made before anything had been checked.
    this.status = { state: 'checking' }
    this.wireAutoUpdater()
  }

  getStatus(): UpdateStatus {
    return this.status
  }

  /** Begins checking. No-op on a build that cannot self-update. */
  start(): void {
    if (this.status.state === 'unsupported') return
    this.check()
    this.checkTimer = setInterval(() => this.check(), CHECK_INTERVAL_MS)
  }

  /**
   * Quits and runs the downloaded installer. Only meaningful in the 'ready'
   * state; called anywhere else electron-updater simply has nothing to
   * install, so this reports rather than pretending.
   *
   * The quit goes through `app.quit()` inside electron-updater, which fires
   * `before-quit` - so main/index.ts's `isQuitting` flag is set before the
   * main window's close handler runs, and the run-in-background tray logic
   * correctly lets this close through instead of hiding the window and
   * cancelling the update.
   */
  restartToInstall(): boolean {
    if (this.status.state !== 'ready') {
      log.warn(`updater: restartToInstall ignored - no update ready (state=${this.status.state})`)
      return false
    }
    log.info(`updater: restarting to install ${this.status.version ?? 'update'}`)
    autoUpdater.quitAndInstall()
    return true
  }

  dispose(): void {
    if (this.checkTimer) clearInterval(this.checkTimer)
    this.checkTimer = null
  }

  private check(): void {
    // Always returns a promise (`Promise.resolve(null)` when the updater is
    // inactive, never a bare null), so no optional chaining is needed here.
    // Rejections are already reported through the 'error' event wired below;
    // this catch only stops an unhandled rejection escaping.
    autoUpdater.checkForUpdates().catch(() => {})
  }

  private wireAutoUpdater(): void {
    // electron-updater is chatty at info level and all of it is useful when
    // an update goes wrong on a machine nobody here can inspect, so it goes
    // to main.log alongside everything else rather than to a console nothing
    // reads in a packaged build.
    autoUpdater.logger = {
      info: (message?: unknown) => log.info(`updater: ${String(message)}`),
      warn: (message?: unknown) => log.warn(`updater: ${String(message)}`),
      error: (message?: unknown) => log.error(`updater: ${String(message)}`)
    }
    // Download without asking. The alternative is a prompt for something the
    // user has no basis to decline, and with the blockmap published alongside
    // each installer (see electron-builder.yml) a typical update transfers a
    // few MB rather than the whole ~94 MB package.
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true

    autoUpdater.on('checking-for-update', () => this.setStatus({ state: 'checking' }))

    autoUpdater.on('update-available', (info: { version: string }) => {
      this.pendingVersion = info.version
      log.info(`updater: ${info.version} available, downloading`)
      this.setStatus({ state: 'downloading', version: info.version, percent: 0 })
    })

    autoUpdater.on('update-not-available', () => {
      this.pendingVersion = undefined
      this.setStatus({ state: 'idle' })
    })

    autoUpdater.on('download-progress', (progress: { percent: number }) => {
      this.setStatus({
        state: 'downloading',
        version: this.pendingVersion,
        percent: Math.round(progress.percent)
      })
    })

    autoUpdater.on('update-downloaded', (info: { version: string }) => {
      this.pendingVersion = info.version
      log.info(`updater: ${info.version} downloaded and verified - installs on quit`)
      this.setStatus({ state: 'ready', version: info.version })
    })

    autoUpdater.on('error', (err: Error) => {
      // Precise text to the log, one plain sentence to the screen - the same
      // split BackendStatus makes. A failed update check is not something a
      // user can act on, and it must not read as though dictation is broken.
      log.error(`updater: ${err.message}`)
      this.setStatus({ state: 'error', detail: 'Could not check for updates.' })
    })
  }

  private setStatus(status: UpdateStatus): void {
    this.status = status
    this.emit('status', status)
  }
}
