import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type {
  AudioChunkPayload,
  InferenceBackend,
  StartSessionOptions,
  TransformMode
} from '../../shared/backend'

function toAudioChunk(payload: AudioChunkPayload): Int16Array | Buffer {
  if (payload.kind === 'pcm16') {
    return new Int16Array(payload.buffer)
  }
  return Buffer.from(payload.buffer)
}

/**
 * Wires the InferenceBackend up to IPC. This is the only place that knows
 * both "Electron IPC" and "InferenceBackend" - swapping MockBackend for the
 * real LiteRT-LM sidecar later means changing the constructor call in
 * src/main/index.ts, not anything in here.
 */
export function registerBackendIpc(
  backend: InferenceBackend,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle(IPC.backend.startSession, (_event, opts?: StartSessionOptions) =>
    backend.startSession(opts)
  )

  ipcMain.on(IPC.backend.pushAudio, (_event, sessionId: string, payload: AudioChunkPayload) => {
    backend.pushAudio(sessionId, toAudioChunk(payload))
  })

  ipcMain.handle(IPC.backend.endSession, (_event, sessionId: string) =>
    backend.endSession(sessionId)
  )

  ipcMain.handle(IPC.backend.cleanup, (_event, text: string) => backend.cleanup(text))

  ipcMain.handle(IPC.backend.transform, (_event, text: string, mode: TransformMode) =>
    backend.transform(text, mode)
  )

  ipcMain.handle(IPC.backend.voiceEdit, (_event, text: string, command: string) =>
    backend.voiceEdit(text, command)
  )

  backend.onPartialTranscript((sessionId, text) => {
    getWindow()?.webContents.send(IPC.backend.partialTranscript, sessionId, text)
  })
}
