import { app, shell, BrowserWindow, globalShortcut } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/ipc-channels'
import { MockBackend } from './backend/mockBackend'
import { HistoryStore } from './store/historyStore'
import { SettingsStore } from './store/settingsStore'
import { registerBackendIpc } from './ipc/backendIpc'
import { registerHistoryIpc } from './ipc/historyIpc'
import { registerSettingsIpc } from './ipc/settingsIpc'
import { applyGlobalShortcut } from './hotkey'

let mainWindow: BrowserWindow | null = null

// Swap MockBackend for the real LiteRT-LM sidecar backend here once it's
// ready - everything downstream (IPC, renderer) only depends on the
// InferenceBackend interface, not on this concrete class.
const backend = new MockBackend()
const historyStore = new HistoryStore(app.getPath('userData'))
const settingsStore = new SettingsStore(app.getPath('userData'))

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1000,
    height: 720,
    minWidth: 720,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#111318',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  window.on('ready-to-show', () => {
    window.show()
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return window
}

/** Brings the app to the front and asks the renderer to toggle recording. */
function toggleRecordingFromHotkey(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
  mainWindow.webContents.send(IPC.hotkey.toggleRecording)
}

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.windowseloquent.app')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  mainWindow = createWindow()

  registerBackendIpc(backend, () => mainWindow)
  registerHistoryIpc(historyStore)
  registerSettingsIpc(settingsStore, (accelerator) =>
    applyGlobalShortcut(accelerator, toggleRecordingFromHotkey)
  )

  applyGlobalShortcut(settingsStore.get().hotkey, toggleRecordingFromHotkey)

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
})
