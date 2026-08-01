import { Menu, Tray, nativeImage } from 'electron'
import { log } from './log'

/**
 * Windows draws tray icons at 16x16 (scaled up on high-DPI displays).
 * resources/icon.png is the 512x512 app icon, and handing that to Tray
 * unresized produces a visibly soft, badly-downscaled blob - so it is
 * resized explicitly here rather than left to whatever the platform does
 * with a 32x-oversized bitmap.
 */
const TRAY_ICON_SIZE = 16

export interface TrayHandlers {
  /** Open/focus the main window - the tray's primary action (menu item and click). */
  onOpen: () => void
  /** Really quit, as opposed to closing the window (which by default only hides it). */
  onQuit: () => void
}

/**
 * Decides what a click on the main window's close button means.
 *
 * Pure and exported for tests: this predicate is the whole feature, and
 * getting it wrong is expensive in both directions. Returning true when it
 * should be false makes the app impossible to quit by normal means;
 * returning false when it should be true kills the sidecar and disarms the
 * global push-to-talk hook the moment someone tidies their desktop.
 *
 * `isQuitting` is the load-bearing half. Once a real quit is under way
 * (tray menu, Alt+F4 chains, OS shutdown - anything that fires
 * `before-quit`), Electron closes every window, and hiding them instead
 * would silently cancel the quit and leave a process no UI can reach.
 */
export function shouldHideOnClose(options: {
  runInBackground: boolean
  isQuitting: boolean
}): boolean {
  return options.runInBackground && !options.isQuitting
}

/**
 * Creates the system-tray icon and its menu.
 *
 * Created unconditionally at startup, not only while `runInBackground` is
 * on. Blurt holds a global push-to-talk hook and a global hotkey, so it is
 * doing things whether or not its window is visible - a tray presence is
 * the honest indicator of that, and it means there is always a visible way
 * to quit. (With `runInBackground` off, the app quits on window close
 * anyway, so the icon simply disappears with it.)
 *
 * Returns null if the platform/desktop environment refuses to create a tray
 * (a real possibility on Linux without an StatusNotifier host). That is
 * degraded, not fatal - the caller keeps working, so this never throws.
 */
export function createTray(iconPath: string, handlers: TrayHandlers): Tray | null {
  try {
    const image = nativeImage
      .createFromPath(iconPath)
      .resize({ width: TRAY_ICON_SIZE, height: TRAY_ICON_SIZE })
    const tray = new Tray(image)

    tray.setToolTip('Blurt')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Blurt', click: handlers.onOpen },
        { type: 'separator' },
        { label: 'Quit Blurt', click: handlers.onQuit }
      ])
    )
    // Windows convention: a plain left-click opens the app, and the menu is
    // the right-click. Without this the only way back to the window is the
    // context menu, which is a lot of ceremony for the common case.
    tray.on('click', handlers.onOpen)

    log.info('tray: created')
    return tray
  } catch (err) {
    log.warn(
      `tray: could not create tray icon: ${err instanceof Error ? err.message : String(err)}`
    )
    return null
  }
}

/**
 * The one-time "it's still running" notification, shown the first time the
 * window is closed to the tray. Best-effort: `displayBalloon` is Windows-only
 * and can be suppressed by Focus Assist or notification settings entirely,
 * so this must never be something the caller has to handle failing.
 */
export function showTrayHint(tray: Tray | null): void {
  if (!tray || process.platform !== 'win32') return
  try {
    tray.displayBalloon({
      title: 'Blurt is still running',
      content: 'Push to talk still works. Quit from the tray icon when you want it gone.'
    })
  } catch (err) {
    log.warn(`tray: could not show hint: ${err instanceof Error ? err.message : String(err)}`)
  }
}
