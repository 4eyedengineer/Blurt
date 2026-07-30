import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type {
  AudioChunkPayload,
  BackendErrorSource,
  InferenceBackend,
  StartSessionOptions,
  TransformMode
} from '../../shared/backend'
import type { BackendController } from '../backend/backendController'

function hasErrorSource(
  backend: InferenceBackend
): backend is InferenceBackend & BackendErrorSource {
  return typeof (backend as Partial<BackendErrorSource>).onError === 'function'
}

/**
 * Wires the currently-active InferenceBackend up to IPC. Every handler
 * resolves `controller.getBackend()` at call time (not once, up front) so a
 * hot-swap (mock <-> LiteRT-LM, or a sidecar restart producing a new
 * backend instance) is picked up transparently - see
 * src/main/backend/backendController.ts.
 */
/**
 * Broadcasts a main -> renderer event to every currently-live window that
 * wants it (the main window, and - for dictation session events - the
 * push-to-talk overlay window too, since it drives its own dictation
 * session over the exact same IPC surface - see
 * src/renderer/src/overlay/useOverlayPushToTalk.ts).
 */
function broadcast(
  getWindows: () => Array<BrowserWindow | null>,
  channel: string,
  ...args: unknown[]
): void {
  for (const window of getWindows()) {
    if (window && !window.isDestroyed()) window.webContents.send(channel, ...args)
  }
}

export function registerBackendIpc(
  controller: BackendController,
  getWindows: () => Array<BrowserWindow | null>
): void {
  ipcMain.handle(IPC.backend.startSession, (_event, opts?: StartSessionOptions) =>
    controller.getBackend().startSession(opts)
  )

  ipcMain.on(IPC.backend.pushAudio, (_event, sessionId: string, payload: AudioChunkPayload) => {
    controller.getBackend().pushAudio(sessionId, new Int16Array(payload.buffer))
  })

  ipcMain.handle(IPC.backend.endSession, (_event, sessionId: string) =>
    controller.getBackend().endSession(sessionId)
  )

  ipcMain.handle(IPC.backend.cleanup, (_event, text: string, operationId?: string) =>
    controller.getBackend().cleanup(text, operationId)
  )

  ipcMain.handle(
    IPC.backend.transform,
    (_event, text: string, mode: TransformMode, operationId?: string) =>
      controller.getBackend().transform(text, mode, operationId)
  )

  ipcMain.handle(
    IPC.backend.voiceEdit,
    (_event, text: string, command: string, operationId?: string) =>
      controller.getBackend().voiceEdit(text, command, operationId)
  )

  ipcMain.handle(IPC.backend.getStatus, () => controller.getStatus())

  // Partial-transcript / session-error subscriptions are per backend-instance
  // EventEmitters, so they need to be re-attached every time the backend
  // itself is swapped out (not just when settings change - a rebuild can
  // fail and fall back to a different concrete instance).
  let unsubscribePartial: () => void = () => {}
  let unsubscribeError: () => void = () => {}
  let unsubscribeTextStream: () => void = () => {}

  function attachToBackend(backend: InferenceBackend): void {
    unsubscribePartial()
    unsubscribeError()
    unsubscribeTextStream()

    unsubscribePartial = backend.onPartialTranscript((sessionId, text) => {
      broadcast(getWindows, IPC.backend.partialTranscript, sessionId, text)
    })

    unsubscribeTextStream = backend.onTextStreamProgress((operationId, text) => {
      broadcast(getWindows, IPC.backend.textStreamProgress, operationId, text)
    })

    unsubscribeError = hasErrorSource(backend)
      ? backend.onError((sessionId, error) => {
          broadcast(getWindows, IPC.backend.sessionError, sessionId, error)
        })
      : () => {}
  }

  attachToBackend(controller.getBackend())
  controller.on('backend-changed', attachToBackend)

  controller.on('status', (status) => {
    broadcast(getWindows, IPC.backend.statusChanged, status)
  })
}
