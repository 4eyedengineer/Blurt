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
import {
  getRuntimeBaseDir,
  isVenvHealthy,
  venvPathsFor,
  type VenvPaths
} from './runtime/venvResolver'
import { runFirstRunSetup, SETUP_STEPS } from './runtime/firstRunSetup'
import { SetupWindow } from './runtime/setupWindow'

let mainWindow: BrowserWindow | null = null
let overlayWindow: BrowserWindow | null = null
let pushToTalkController: PushToTalkController | null = null
let backendController: BackendController | null = null

/**
 * Exactly one instance may run at a time. Two instances is not a cosmetic
 * problem here: both bind the same sidecar port and share one
 * `userData/sidecar.pid`, so each one's pre-spawn port hygiene (see
 * `portGuard.ts`) recognizes the *other's* freshly-spawned child as "our
 * stale sidecar" and kills it - observed on a real host as an endless
 * mutual-kill loop that flashed several "Error" states in the status pill
 * before one side finally won. A second launch just focuses the first
 * window instead.
 */
const isPrimaryInstance = app.requestSingleInstanceLock()
if (!isPrimaryInstance) app.quit()

initLog(app.getPath('userData'), is.dev)
const historyStore = new HistoryStore(app.getPath('userData'))
const settingsStore = new SettingsStore(app.getPath('userData'))
const modelManager = new ModelManager(app.getPath('userData'))

/**
 * Establishes the self-managed runtime venv the packaged app's managed
 * sidecar depends on, with no launcher involved - see
 * `runtime/venvResolver.ts` / `runtime/firstRunSetup.ts`'s doc comments.
 * Only meaningful on win32 (the packaged app's only real target - see
 * WINDOWS.md); a no-op elsewhere so WSL/Linux/mac dev builds (which don't
 * have `%LOCALAPPDATA%` at all) are unaffected, and instead rely on the
 * sidecar command being configured by hand in Settings (see
 * `DEFAULT_MANAGED_COMMAND`'s doc comment in shared/types.ts).
 *
 * Returns the resolved venv paths on success (already-healthy or freshly
 * set up), or `undefined` if setup failed - in which case a hard-error
 * setup screen is already showing and the caller must not proceed to
 * create the rest of the app (the caller quits once the user closes it).
 */
async function ensureRuntime(): Promise<VenvPaths | undefined> {
  if (process.platform !== 'win32') return undefined

  const venv = venvPathsFor(join(getRuntimeBaseDir(), 'venv'), 'win32')
  if (isVenvHealthy(venv)) {
    log.info(`runtime: venv healthy, reusing ${venv.venvDir}`)
    return venv
  }

  log.info(`runtime: no healthy venv at ${venv.venvDir} - running first-run setup`)
  const setupWindow = new SetupWindow(SETUP_STEPS)

  try {
    await runFirstRunSetup(venv, {
      onStepStart: (id) => void setupWindow.setStepState(id, 'active'),
      onStepDone: (id) => void setupWindow.setStepState(id, 'done'),
      onLine: (line) => {
        log.info(`runtime-setup: ${line}`)
        void setupWindow.appendLog(line)
      }
    })
    log.info(`runtime: first-run setup complete (${venv.venvDir})`)
    setupWindow.close()
    return venv
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.error(`runtime: first-run setup failed: ${message}`)
    await setupWindow.showFatalError(message)
    // The hard-error screen's only available action is closing the window
    // (see setupWindow.ts) - wait for that, then let the caller quit rather
    // than limping on with no working sidecar.
    await new Promise<void>((resolve) => setupWindow.onClosed(resolve))
    return undefined
  }
}

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

app.whenReady().then(async () => {
  // A second instance already called app.quit() above - don't build an app
  // (or a second sidecar) on the way out.
  if (!isPrimaryInstance) return

  electronApp.setAppUserModelId('com.blurt.app')

  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const venvPaths = await ensureRuntime()
  if (process.platform === 'win32' && !venvPaths) {
    // ensureRuntime() already left a hard-error setup screen up and waited
    // for the user to close it (see its doc comment) - nothing left to do
    // but quit; there is no usable app without a runtime venv on Windows.
    app.quit()
    return
  }

  // The single seam that knows about LitertBackend (and its
  // UnavailableBackend error-state placeholder) - which concrete
  // InferenceBackend is active is driven entirely by settingsStore
  // ('modelId' / 'sidecar' fields) and can change at runtime (see
  // registerSettingsIpc's onBackendSettingsChanged hook). Everything
  // downstream (IPC, renderer) only depends on the InferenceBackend
  // interface via backendController.getBackend().
  backendController = new BackendController(
    settingsStore,
    modelManager,
    app.getPath('userData'),
    join(app.getPath('userData'), 'debug'),
    venvPaths
  )
  // Local, non-nullable alias: `backendController` (the outer `let`) reads
  // back as possibly-null in the closures below (TS can't narrow a mutable
  // outer binding across closure boundaries) even though it's only ever
  // reassigned here, once, before any of them run.
  const controller = backendController

  mainWindow = createWindow()
  // The push-to-talk overlay below is a real BrowserWindow that stays open
  // (just hidden) for the app's whole lifetime, so 'window-all-closed' can
  // never fire on its own - closing the main window used to leave the
  // process running with the overlay pill still floating on screen. Closing
  // the main window is the user closing the app, so quit explicitly.
  mainWindow.on('closed', () => {
    mainWindow = null
    if (process.platform !== 'darwin') app.quit()
  })

  overlayWindow = createOverlayWindow()
  log.info('overlay: window created')

  pushToTalkController = new PushToTalkController(settingsStore.get().pushToTalk.key)
  pushToTalkController.applySettings(settingsStore.get().pushToTalk)
  new OverlayController(
    pushToTalkController,
    () => overlayWindow,
    settingsStore,
    historyStore,
    () => mainWindow?.webContents.send(IPC.history.changed),
    ipcMain
  )
  registerPushToTalkIpc(pushToTalkController)

  registerBackendIpc(controller, () => [mainWindow, overlayWindow])
  // Cheap diagnostic parity with the overlay/push-to-talk logs above -
  // surfaces sidecar state and (once observed) the truthful effective
  // accelerator (see BackendStatus.effectiveAccelerator) without needing
  // devtools open.
  controller.on('status', (status) => log.info(`backend: status ${JSON.stringify(status)}`))
  registerHistoryIpc(historyStore)
  registerSettingsIpc(
    settingsStore,
    (accelerator) => applyGlobalShortcut(accelerator, toggleRecordingFromHotkey),
    () => void controller.rebuild(),
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
      controller.getStatus().state === 'error'
    ) {
      void controller.rebuild()
    }
  })

  void controller.rebuild()
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

// Fires on Windows too (not darwin-only) whenever app.quit() actually
// proceeds - including via the window-all-closed handler above - so a
// normal window-close/quit does kill the managed sidecar here (verified on
// a real Windows host: child.kill() reliably TerminateProcess()es a
// python.exe sidecar and its GPU/VRAM is released immediately). This is
// only the *graceful* path, though: a killed/crashed main process (Task
// Manager, `taskkill /f`, a Windows shutdown that doesn't wait) skips this
// entirely - that gap is why `resources/serve_gpu.py` also runs its own
// parent-watchdog (`ELOQUENT_PARENT_PID`, set in `sidecar.ts`'s
// `spawnManaged`), which notices the main process dying and shuts the
// sidecar down itself within seconds even when this handler never runs.
// BackendController/Sidecar additionally has a pid-file-based reclaim step
// for the *next* launch as a last-resort backstop - see `portGuard.ts`'s
// doc comment for the real incident that motivated it.
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Null only if the app quit before ensureRuntime() ever resolved (the
  // first-run setup hard-error path - see ensureRuntime()'s doc comment) -
  // nothing to dispose of in that case.
  backendController?.dispose()
  pushToTalkController?.dispose()
})
