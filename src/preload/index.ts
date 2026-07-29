import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/ipc-channels'
import type {
  BackendError,
  BackendStatus,
  StartSessionOptions,
  TransformMode,
  AudioChunkPayload
} from '../shared/backend'
import type {
  ModelId,
  NewDictationEntry,
  PasteOutcome,
  PushToTalkStatus,
  Settings
} from '../shared/types'
import type { InstalledModelInfo, ModelDownloadProgress } from '../shared/models'

/**
 * The renderer-facing API surface. Renderer code never touches Electron or
 * Node primitives directly - everything goes through here, and every
 * method just forwards to a typed IPC channel handled in src/main/ipc/*.ts.
 */
const dictationApi = {
  startSession: (opts?: StartSessionOptions): Promise<string> =>
    ipcRenderer.invoke(IPC.backend.startSession, opts),

  pushAudio: (sessionId: string, payload: AudioChunkPayload): void => {
    ipcRenderer.send(IPC.backend.pushAudio, sessionId, payload)
  },

  endSession: (sessionId: string): Promise<string> =>
    ipcRenderer.invoke(IPC.backend.endSession, sessionId),

  cleanup: (text: string): Promise<string> => ipcRenderer.invoke(IPC.backend.cleanup, text),

  transform: (text: string, mode: TransformMode): Promise<string> =>
    ipcRenderer.invoke(IPC.backend.transform, text, mode),

  voiceEdit: (text: string, command: string): Promise<string> =>
    ipcRenderer.invoke(IPC.backend.voiceEdit, text, command),

  onPartialTranscript: (listener: (sessionId: string, text: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, sessionId: string, text: string): void =>
      listener(sessionId, text)
    ipcRenderer.on(IPC.backend.partialTranscript, handler)
    return () => ipcRenderer.removeListener(IPC.backend.partialTranscript, handler)
  },

  onSessionError: (listener: (sessionId: string, error: BackendError) => void): (() => void) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      sessionId: string,
      error: BackendError
    ): void => listener(sessionId, error)
    ipcRenderer.on(IPC.backend.sessionError, handler)
    return () => ipcRenderer.removeListener(IPC.backend.sessionError, handler)
  },

  getStatus: (): Promise<BackendStatus> => ipcRenderer.invoke(IPC.backend.getStatus),

  onStatusChanged: (listener: (status: BackendStatus) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: BackendStatus): void =>
      listener(status)
    ipcRenderer.on(IPC.backend.statusChanged, handler)
    return () => ipcRenderer.removeListener(IPC.backend.statusChanged, handler)
  }
}

const historyApi = {
  list: () => ipcRenderer.invoke(IPC.history.list),
  search: (query: string) => ipcRenderer.invoke(IPC.history.search, query),
  save: (entry: NewDictationEntry & { id?: string }) => ipcRenderer.invoke(IPC.history.save, entry),
  remove: (id: string) => ipcRenderer.invoke(IPC.history.remove, id),
  get: (id: string) => ipcRenderer.invoke(IPC.history.get, id)
}

const settingsApi = {
  get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settings.get),
  update: (patch: Partial<Settings>): Promise<Settings> =>
    ipcRenderer.invoke(IPC.settings.update, patch),
  addVocabularyWord: (word: string): Promise<Settings> =>
    ipcRenderer.invoke(IPC.settings.addVocabularyWord, word),
  removeVocabularyWord: (word: string): Promise<Settings> =>
    ipcRenderer.invoke(IPC.settings.removeVocabularyWord, word),
  updateHotkey: (accelerator: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke(IPC.settings.updateHotkey, accelerator)
}

const hotkeyApi = {
  onToggleRecording: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.hotkey.toggleRecording, handler)
    return () => ipcRenderer.removeListener(IPC.hotkey.toggleRecording, handler)
  }
}

const modelsApi = {
  list: (): Promise<{ installed: InstalledModelInfo[]; progress: ModelDownloadProgress[] }> =>
    ipcRenderer.invoke(IPC.models.list),
  download: (modelId: ModelId): Promise<void> => ipcRenderer.invoke(IPC.models.download, modelId),
  cancelDownload: (modelId: ModelId): Promise<void> =>
    ipcRenderer.invoke(IPC.models.cancelDownload, modelId),
  remove: (modelId: ModelId): Promise<void> => ipcRenderer.invoke(IPC.models.remove, modelId),
  onProgress: (listener: (progress: ModelDownloadProgress) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, progress: ModelDownloadProgress): void =>
      listener(progress)
    ipcRenderer.on(IPC.models.progress, handler)
    return () => ipcRenderer.removeListener(IPC.models.progress, handler)
  }
}

const pushToTalkApi = {
  getStatus: (): Promise<PushToTalkStatus> => ipcRenderer.invoke(IPC.pushToTalk.getStatus)
}

/**
 * Bridge used only by the overlay window's renderer (src/renderer/src/overlay/*)
 * to receive start/stop/cancel/reset commands from OverlayController and to
 * report its cleaned-text result back for clipboard/paste handling - see
 * src/main/overlayController.ts.
 */
const overlayApi = {
  onPttStart: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.overlay.pttStart, handler)
    return () => ipcRenderer.removeListener(IPC.overlay.pttStart, handler)
  },
  onPttStop: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.overlay.pttStop, handler)
    return () => ipcRenderer.removeListener(IPC.overlay.pttStop, handler)
  },
  onPttCancel: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.overlay.pttCancel, handler)
    return () => ipcRenderer.removeListener(IPC.overlay.pttCancel, handler)
  },
  onReset: (listener: () => void): (() => void) => {
    const handler = (): void => listener()
    ipcRenderer.on(IPC.overlay.reset, handler)
    return () => ipcRenderer.removeListener(IPC.overlay.reset, handler)
  },
  onPasteStatus: (listener: (status: PasteOutcome) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: PasteOutcome): void =>
      listener(status)
    ipcRenderer.on(IPC.overlay.pasteStatus, handler)
    return () => ipcRenderer.removeListener(IPC.overlay.pasteStatus, handler)
  },
  sendResult: (payload: { rawTranscript: string; cleanedText: string }): void => {
    ipcRenderer.send(IPC.overlay.result, payload)
  }
}

const api = {
  dictation: dictationApi,
  history: historyApi,
  settings: settingsApi,
  hotkey: hotkeyApi,
  models: modelsApi,
  pushToTalk: pushToTalkApi,
  overlay: overlayApi
}

export type Api = typeof api

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = electronAPI
  // @ts-ignore (define in dts)
  window.api = api
}
