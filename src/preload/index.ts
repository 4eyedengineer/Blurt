import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import { IPC } from '../shared/ipc-channels'
import type { StartSessionOptions, TransformMode, AudioChunkPayload } from '../shared/backend'
import type { NewDictationEntry, Settings } from '../shared/types'

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

const api = {
  dictation: dictationApi,
  history: historyApi,
  settings: settingsApi,
  hotkey: hotkeyApi
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
