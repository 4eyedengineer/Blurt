import { Menu, Notification, Tray, nativeImage } from 'electron'
import { log } from './log'

/**
 * Tray/menu-bar icon pixel size (at 1x scale), by platform.
 *
 * Windows draws tray icons at 16x16 (scaled up on high-DPI displays).
 * resources/icon.png is the 512x512 app mark, and handing that to Tray
 * unresized produces a visibly soft, badly-downscaled blob - so it is
 * resized explicitly in createTray() rather than left to whatever the
 * platform does with a 32x-oversized bitmap.
 *
 * A 512 -> 16 downscale is good enough to be indistinguishable from the
 * .ico's purpose-rendered 16px layer (compared side by side at 8x
 * magnification), because the mark is a plain speech bubble drawn to stay
 * legible at exactly this size - see build/icon.svg's comment. So the tray
 * needs no icon file of its own on Windows.
 *
 * macOS specs its menu bar icons at 22x22 at 1x (an NSStatusItem's default
 * size) - noticeably bigger than Windows' 16px, and everything else in the
 * menu bar is drawn at that size, so reusing the Windows figure there would
 * render Blurt's icon smaller than its neighbours, not just softer. Any
 * platform that is neither of these (e.g. Linux, where tray sizing varies
 * by desktop environment and there is no single documented "correct" size)
 * keeps the Windows figure, since that's what this code has always used
 * there and it has looked acceptable in practice.
 *
 * Unverified so far - nobody has run this on a Mac yet - whether a 512 ->
 * 22 downscale of this particular source asset still reads cleanly once
 * it's forced through setTemplateImage's silhouette-only rendering (see
 * createTray() below); worth a look on real hardware once one is
 * available.
 */
export function trayIconSizeFor(platform: NodeJS.Platform): number {
  return platform === 'darwin' ? 22 : 16
}

/**
 * Whether the tray icon should be marked as a macOS "template image" - see
 * createTray()'s comment for what that means and its (known, accepted)
 * downside on today's full-colour source asset. Darwin only: Windows has no
 * such concept, and there is no reason to touch it on any other platform.
 */
export function shouldUseTemplateImage(platform: NodeJS.Platform): boolean {
  return platform === 'darwin'
}

/**
 * Whether createTray() should treat a plain left-click on the tray icon as
 * "open the app" - see createTray()'s comment. True everywhere except
 * macOS, where a Tray with a context menu attached shows that menu on any
 * click, making `click` an unreliable "the user wants the window" signal
 * there.
 */
export function shouldRegisterClickHandler(platform: NodeJS.Platform): boolean {
  return platform !== 'darwin'
}

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
    const platform = process.platform
    const size = trayIconSizeFor(platform)
    const image = nativeImage.createFromPath(iconPath).resize({ width: size, height: size })
    if (image.isEmpty()) {
      // A NativeImage that failed to load (bad path, corrupt PNG, etc.)
      // resizes to an empty image, and both resize() and `new Tray(...)`
      // below accept that without complaint - the result is an outwardly
      // "successful" tray icon that is just invisible. This is the only
      // thing that would ever surface that in main.log instead of it being
      // silently blank in the tray/menu bar.
      log.warn(`tray: resized icon is empty, source may have failed to load (${iconPath})`)
    }
    if (shouldUseTemplateImage(platform)) {
      // Template images: macOS derives a solid black silhouette from the
      // source's alpha channel and recolors/inverts it itself, which is
      // what lets one icon look right on both light and dark menu bars and
      // invert correctly when highlighted/pressed. Without this, a
      // full-colour image just sits there as a plain bitmap - wrong
      // against a dark menu bar and never highlighting like its
      // neighbours do.
      //
      // The honest cost: resources/icon.png is a full-colour 512px mark
      // (see build/icon.svg), and a template image throws away all of that
      // colour - only the alpha channel survives. So this will render as a
      // solid speech-bubble-shaped silhouette in the menu bar, not the
      // coloured mark seen everywhere else in the app. A dedicated
      // monochrome/alpha-only asset is probably wanted here eventually;
      // this reuses what already exists rather than speculatively adding a
      // new build asset. Unverified on real hardware - nobody has run this
      // on a Mac yet.
      image.setTemplateImage(true)
    }
    const tray = new Tray(image)

    tray.setToolTip('Blurt')
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open Blurt', click: handlers.onOpen },
        { type: 'separator' },
        { label: 'Quit Blurt', click: handlers.onQuit }
      ])
    )
    if (shouldRegisterClickHandler(platform)) {
      // Windows convention: a plain left-click opens the app, and the menu
      // is the right-click. Without this the only way back to the window
      // is the context menu, which is a lot of ceremony for the common
      // case. Excluded on macOS - see shouldRegisterClickHandler's comment.
      tray.on('click', handlers.onOpen)
    }

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
 * window is closed to the tray. Best-effort on every platform it's
 * implemented for: `displayBalloon` is Windows-only and can be suppressed
 * by Focus Assist or notification settings entirely, and macOS's
 * `Notification` can just as easily be denied or ignored via Notification
 * Center settings - so this must never be something the caller has to
 * handle failing.
 *
 * The macOS path is unverified so far - nobody has run this on a Mac yet.
 * A notification from an unsigned/un-notarized development build may
 * simply not appear, and macOS may not even prompt for Notification Center
 * permission for one at all - a known rough edge for Electron apps in dev,
 * and not something this function can detect or work around from in here.
 * The log lines below are how to tell "this code ran" from "the OS
 * silently ate it" until someone can check on real hardware.
 */
export function showTrayHint(tray: Tray | null): void {
  if (!tray) return
  const title = 'Blurt is still running'
  const body = 'Push to talk still works. Quit from the tray icon when you want it gone.'
  try {
    if (process.platform === 'win32') {
      tray.displayBalloon({ title, content: body })
      return
    }
    if (process.platform === 'darwin') {
      if (!Notification.isSupported()) {
        log.warn('tray: hint skipped, Notification.isSupported() returned false')
        return
      }
      new Notification({ title, body }).show()
      log.info(
        'tray: hint shown via Notification (darwin) - not yet confirmed visible on a real Mac'
      )
      return
    }
    // No hint mechanism implemented for this platform (e.g. Linux) - the
    // same silent no-op as before this function grew a darwin path. The
    // tray icon and its context menu remain the discoverable way to quit
    // even without it.
  } catch (err) {
    log.warn(`tray: could not show hint: ${err instanceof Error ? err.message : String(err)}`)
  }
}
