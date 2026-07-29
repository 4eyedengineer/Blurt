import type { TransformMode } from './backend'

export type ModelId = 'gemma-4-e2b' | 'gemma-4-e4b' | 'gemma-4-12b'

export type BackendMode = 'offline' | 'cloud'

export interface Settings {
  modelId: ModelId
  mode: BackendMode
  autoCopyOnCleanup: boolean
  customVocabulary: string[]
  /** Electron accelerator string, e.g. "Ctrl+Shift+Space". */
  hotkey: string
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: 'gemma-4-e2b',
  mode: 'offline',
  autoCopyOnCleanup: false,
  customVocabulary: [],
  hotkey: 'Ctrl+Shift+Space'
}

export type DictationDisplayMode = TransformMode | 'none'

export interface DictationEntry {
  id: string
  createdAt: number
  /** Raw ASR output, before the cleanup pass. */
  rawTranscript: string
  /** Cleaned transcript (filler words stripped, casing fixed). */
  cleanedText: string
  /** Whatever is currently shown for this entry (cleaned or transformed). */
  displayText: string
  /** Which transform (if any) produced displayText. */
  displayMode: DictationDisplayMode
  wordCount: number
  durationMs: number
  wpm: number
}

export type NewDictationEntry = Omit<DictationEntry, 'id' | 'createdAt'>
