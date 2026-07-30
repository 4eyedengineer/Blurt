import { app, shell, BrowserWindow, globalShortcut, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { IPC } from '../shared/ipc-channels'
import { BackendController } from './backend/backendController'
import { ModelManager } from './backend/modelManager'
import { HistoryStore } from './store/historyStore'
import { SettingsStore } from './store/settingsStore'
import { registerBackendIpc } from './ipc/backendIpc'
import { registerHistoryIpc } from './ipc/historyIpc'
import { registerSettingsIpc } from './ipc/settingsIpc'
import { registerModelManagerIpc } from './ipc/modelManagerIpc'
import { registerPushToTalkIpc } from './ipc/pushToTalkIpc'
import { registerLogIpc } from './ipc/logIpc'
import { applyGlobalShortcut } from './hotkey'
import { createOverlayWindow } from './overlay'
import { OverlayController } from './overlayController'
import { PushToTalkController } from './pushToTalk/pushToTalkController'
import { initLog, log } from './log'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let pushToTalkController: PushToTalkController | null = null

initLog(app.getPath('userData'), is.dev)
const historyStore = new HistoryStore(app.getPath('userData'))
const settingsStore = new SettingsStore(app.getPath('userData'))
const modelManager = new ModelManager(app.getPath('userData'))

// The single seam that knows about both MockBackend and LitertBackend -
// which concrete InferenceBackend is active is driven entirely by
// settingsStore ('backend' / 'modelId' / 'sidecar' fields) and can change
// at runtime (see registerSettingsIpc's onBackendSettingsChanged hook).
// Everything downstream (IPC, renderer) only depends on the
// InferenceBackend interface via backendController.getBackend().
const backendController = new BackendController(
  settingsStore,
  modelManager,
  join(app.getPath('userData'), 'debug')
)

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

  overlayWindow = createOverlayWindow()
  log.info('overlay: window created')

  pushToTalkController = new PushToTalkController(settingsStore.get().pushToTalk.key)
  pushToTalkController.applySettings(settingsStore.get().pushToTalk)
  new OverlayController(pushToTalkController, () => overlayWindow, settingsStore, ipcMain)
  registerPushToTalkIpc(pushToTalkController)

  registerBackendIpc(backendController, () => [mainWindow, overlayWindow])
  // Cheap diagnostic parity with the overlay/push-to-talk logs above -
  // surfaces sidecar state and (once observed) the truthful effective
  // accelerator (see BackendStatus.effectiveAccelerator) without needing
  // devtools open.
  backendController.on('status', (status) => log.info(`backend: status ${JSON.stringify(status)}`))
  registerHistoryIpc(historyStore)
  registerSettingsIpc(
    settingsStore,
    (accelerator) => applyGlobalShortcut(accelerator, toggleRecordingFromHotkey),
    () => void backendController.rebuild(),
    (pushToTalkSettings) => pushToTalkController?.applySettings(pushToTalkSettings)
  )
  registerModelManagerIpc(modelManager, settingsStore, () => mainWindow)
  registerLogIpc(app.getPath('userData'))

  // If a model finishes downloading while it's the currently-selected model
  // and the backend is sitting in an error state (most likely because that
  // exact model wasn't installed yet), automatically retry rather than
  // requiring the user to re-toggle a setting.
  modelManager.on('progress', (progress) => {
    if (
      progress.state === 'done' &&
      progress.modelId === settingsStore.get().modelId &&
      backendController.getStatus().state === 'error'
    ) {
      void backendController.rebuild()
    }
  })

  void backendController.rebuild()
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
  backendController.dispose()
  pushToTalkController?.dispose()
})
