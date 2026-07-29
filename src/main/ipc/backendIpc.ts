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

function toAudioChunk(payload: AudioChunkPayload): Int16Array | Buffer {
  if (payload.kind === 'pcm16') {
    return new Int16Array(payload.buffer)
  }
  return Buffer.from(payload.buffer)
}

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
export function registerBackendIpc(
  controller: BackendController,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC.backend.startSession, (_event, opts?: StartSessionOptions) =>
    controller.getBackend().startSession(opts)
  )

  ipcMain.on(IPC.backend.pushAudio, (_event, sessionId: string, payload: AudioChunkPayload) => {
    controller.getBackend().pushAudio(sessionId, toAudioChunk(payload))
  })

  ipcMain.handle(IPC.backend.endSession, (_event, sessionId: string) =>
    controller.getBackend().endSession(sessionId)
  )

  ipcMain.handle(IPC.backend.cleanup, (_event, text: string) =>
    controller.getBackend().cleanup(text)
  )

  ipcMain.handle(IPC.backend.transform, (_event, text: string, mode: TransformMode) =>
    controller.getBackend().transform(text, mode)
  )

  ipcMain.handle(IPC.backend.voiceEdit, (_event, text: string, command: string) =>
    controller.getBackend().voiceEdit(text, command)
  )

  ipcMain.handle(IPC.backend.getStatus, () => controller.getStatus())

  // Partial-transcript / session-error subscriptions are per backend-instance
  // EventEmitters, so they need to be re-attached every time the backend
  // itself is swapped out (not just when settings change - a rebuild can
  // fail and fall back to a different concrete instance).
  let unsubscribePartial: () => void = () => {}
  let unsubscribeError: () => void = () => {}

  function attachToBackend(backend: InferenceBackend): void {
    unsubscribePartial()
    unsubscribeError()

    unsubscribePartial = backend.onPartialTranscript((sessionId, text) => {
      getWindow()?.webContents.send(IPC.backend.partialTranscript, sessionId, text)
    })

    unsubscribeError = hasErrorSource(backend)
      ? backend.onError((sessionId, error) => {
          getWindow()?.webContents.send(IPC.backend.sessionError, sessionId, error)
        })
      : () => {}
  }

  attachToBackend(controller.getBackend())
  controller.on('backend-changed', attachToBackend)

  controller.on('status', (status) => {
    getWindow()?.webContents.send(IPC.backend.statusChanged, status)
  })
}
