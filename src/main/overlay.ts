import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

export const OVERLAY_WIDTH = 600
export const OVERLAY_HEIGHT = 88
const BOTTOM_MARGIN = 48

/**
 * Creates the always-on-top push-to-talk pill. Kept deliberately
 * unfocusable (`focusable: false`) and only ever shown via `showInactive()`
 * (see showOverlayWindow) - the whole point is that the app the user is
 * dictating into never loses OS focus, which is what makes the later
 * simulated-Ctrl+V land in the right place (see paste.ts).
 */
export function createOverlayWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  // 'screen-saver' is the highest standard alwaysOnTop level Electron
  // exposes - keeps the pill above other always-on-top windows (e.g. video
  // call overlays) as reliably as this platform allows.
  window.setAlwaysOnTop(true, 'screen-saver')
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  positionOverlayWindow(window)

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#overlay`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'overlay' })
  }

  return window
}

/** Bottom-center of the primary display's work area (i.e. excluding the taskbar). */
export function positionOverlayWindow(window: BrowserWindow): void {
  const { x, y, width, height } = screen.getPrimaryDisplay().workArea
  window.setBounds({
    x: Math.round(x + (width - OVERLAY_WIDTH) / 2),
    y: Math.round(y + height - OVERLAY_HEIGHT - BOTTOM_MARGIN),
    width: OVERLAY_WIDTH,
    height: OVERLAY_HEIGHT
  })
}

/** Re-positions (in case the display config changed) and shows without stealing focus. */
export function showOverlayWindow(window: BrowserWindow): void {
  positionOverlayWindow(window)
  window.showInactive()
}
