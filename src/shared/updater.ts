/**
 * Self-update types, plus the one pure decision behind them, shared between
 * the main process (src/main/updater.ts) and the Settings screen.
 *
 * Blurt updates from its own GitHub Releases: electron-builder attaches a
 * `latest.yml` next to each installer at publish time, and electron-updater
 * fetches that file to learn whether a newer version exists and to verify the
 * download's sha512 before running it. Nothing about this reaches a server
 * Blurt controls, and it is the only network call the app makes that is not a
 * model download.
 */

export type UpdateState =
  /** This build cannot update itself at all - see `describeUpdateSupport`. */
  | 'unsupported'
  /** A check completed and found nothing newer. */
  | 'idle'
  | 'checking'
  | 'downloading'
  /** Downloaded and verified; installs on quit, or immediately via `restartToInstall`. */
  | 'ready'
  | 'error'

export interface UpdateStatus {
  state: UpdateState
  /** The version being downloaded or waiting to install. Set for 'downloading' and 'ready' only. */
  version?: string
  /** 0-100 while downloading. */
  percent?: number
  /**
   * One sentence fit to put on screen: why this build cannot self-update
   * ('unsupported'), or what went wrong ('error'). The underlying error text
   * goes to main.log rather than here, the same split `BackendStatus` makes
   * between `message` and `detail`.
   */
  detail?: string
}

export interface UpdateSupportParams {
  platform: NodeJS.Platform
  /** `app.isPackaged` - false for `npm run dev` and for an unpacked build. */
  isPackaged: boolean
}

export type UpdateSupport = { supported: true } | { supported: false; reason: string }

/**
 * Whether this build can update itself, and if not, the sentence explaining
 * why. Kept pure and exported (same reasoning as `canStartGlobalHook` in
 * pushToTalkController.ts) so the platform branch is testable without an
 * Electron runtime or a real Mac.
 *
 * Three ways to be unsupported, and they are checked in this order because
 * the first is true regardless of platform:
 *
 *  - Not packaged. electron-updater itself declines here ("Skip
 *    checkForUpdates because application is not packed"), so a dev build
 *    would otherwise sit on 'checking' forever with no explanation.
 *  - macOS. Updates there go through Squirrel.Mac, which refuses to replace
 *    an app that is not code-signed, and Blurt's mac build has no
 *    certificate (see electron-builder.yml's `CSC_IDENTITY_AUTO_DISCOVERY`
 *    note). Reporting this plainly is better than letting a Mac user watch a
 *    download succeed and then silently do nothing.
 *  - Anything else. Linux is a from-source dev target for this project, not
 *    a distributed one - there is no published artifact for an updater to
 *    find.
 */
export function describeUpdateSupport({
  platform,
  isPackaged
}: UpdateSupportParams): UpdateSupport {
  if (!isPackaged) {
    return { supported: false, reason: 'Development builds do not update themselves.' }
  }
  if (platform === 'darwin') {
    return {
      supported: false,
      reason: 'Automatic updates need a signed app, and the macOS build is not signed yet.'
    }
  }
  if (platform !== 'win32') {
    return {
      supported: false,
      reason: 'Automatic updates are only available in the Windows build.'
    }
  }
  return { supported: true }
}

/**
 * The single line Settings shows for the current update state.
 *
 * Pure and here rather than inline in the screen so the wording is testable,
 * and because two of these sentences are load-bearing rather than decorative:
 * 'idle' asserts the app is up to date, which must only ever be said after a
 * check has actually come back empty, and 'ready' has to tell the user an
 * update will be applied without them doing anything, or they will assume the
 * opposite and go hunting for a button.
 */
export function describeUpdateStatus(status: UpdateStatus): string {
  switch (status.state) {
    case 'unsupported':
      return status.detail ?? 'This build does not update itself.'
    case 'checking':
      return 'Checking for updates…'
    case 'idle':
      return 'Blurt is up to date.'
    case 'downloading':
      return status.percent === undefined
        ? `Downloading ${status.version ?? 'an update'}…`
        : `Downloading ${status.version ?? 'an update'}… ${status.percent}%`
    case 'ready':
      return `Version ${status.version ?? 'update'} is ready. It installs when you quit Blurt.`
    case 'error':
      return status.detail ?? 'Could not check for updates.'
  }
}
