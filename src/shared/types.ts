import type { TransformMode } from './backend'

export type ModelId = 'gemma-4-e2b' | 'gemma-4-e4b' | 'gemma-4-12b'

export type BackendMode = 'offline' | 'cloud'

/** Which InferenceBackend implementation the app should construct. */
export type BackendKind = 'mock' | 'litert'

/**
 * How the LiteRT-LM sidecar HTTP server is obtained:
 * - 'managed': the app spawns it itself, using `managedCommand` as a
 *   template (see `SidecarSettings.managedCommand`).
 * - 'external': the user already has a `litert-lm serve` (or compatible)
 *   process running somewhere and just gives us its base URL - we never
 *   spawn or kill it.
 */
export type SidecarMode = 'managed' | 'external'

export interface SidecarSettings {
  mode: SidecarMode
  /**
   * Command template for 'managed' mode, split on whitespace (quoted
   * segments are respected) and spawned directly - no shell involved.
   * `{port}` is substituted at spawn time; `{modelPath}` is also supported
   * for custom wrapper scripts but the real `litert-lm serve` CLI takes no
   * model-selection flag at all (verified empirically - see
   * scratchpad/sidecar-verification.md §3) - the model is selected
   * per-request via the JSON body's `model` field (the alias it was
   * `litert-lm import`-ed as, see `ModelCatalogEntry.alias`), which is why
   * the default template below doesn't reference `{modelPath}`.
   */
  managedCommand: string
  /** Base URL for 'external' mode, e.g. "http://127.0.0.1:9379" (litert-lm's default port). */
  externalUrl: string
  /** Port used to build the local URL in 'managed' mode, and substituted into managedCommand. */
  port: number
}

export const DEFAULT_SIDECAR_SETTINGS: SidecarSettings = {
  mode: 'managed',
  managedCommand: 'litert-lm serve --host 127.0.0.1 --port {port}',
  externalUrl: 'http://127.0.0.1:9379',
  port: 9379
}

export interface Settings {
  modelId: ModelId
  mode: BackendMode
  /** Which InferenceBackend to actually construct: mocked demo data, or the real LiteRT-LM sidecar. */
  backend: BackendKind
  sidecar: SidecarSettings
  autoCopyOnCleanup: boolean
  customVocabulary: string[]
  /** Electron accelerator string, e.g. "Ctrl+Shift+Space". */
  hotkey: string
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: 'gemma-4-e2b',
  mode: 'offline',
  backend: 'mock',
  sidecar: DEFAULT_SIDECAR_SETTINGS,
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
