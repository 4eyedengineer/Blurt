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

/**
 * Identifier for the key used by the system-wide push-to-talk overlay (see
 * src/main/pushToTalk/*.ts and src/main/overlay.ts). Kept as a small closed
 * union of stable ids rather than a raw OS keycode so it's safe to persist
 * in settings.json and to reason about in the renderer (which never touches
 * uiohook-napi directly - only the main process does).
 */
export type PushToTalkKeyId = 'AltRight' | 'ControlRight' | 'F9'

export const PTT_KEY_OPTIONS: Array<{ id: PushToTalkKeyId; label: string }> = [
  { id: 'AltRight', label: 'Right Alt' },
  { id: 'ControlRight', label: 'Right Ctrl' },
  { id: 'F9', label: 'F9' }
]

export interface PushToTalkSettings {
  /** Master on/off switch for the global hold-to-talk overlay. No-ops if the native key-hook failed to load - see PushToTalkStatus. */
  enabled: boolean
  key: PushToTalkKeyId
  /** Whether to simulate Ctrl+V into the previously-focused app after cleanup, in addition to always copying to the clipboard. */
  autoPaste: boolean
}

export const DEFAULT_PUSH_TO_TALK_SETTINGS: PushToTalkSettings = {
  enabled: true,
  key: 'AltRight',
  autoPaste: true
}

/**
 * Reported by the main process (src/main/ipc/pushToTalkIpc.ts) so Settings
 * can explain *why* push-to-talk isn't working, rather than failing
 * silently - see PushToTalkController.getAvailability() and
 * src/main/wsl.ts/src/main/paste.ts for how each field is derived.
 */
export interface PushToTalkStatus {
  /** False if the uiohook-napi native module failed to load on this machine (see `reason`). */
  available: boolean
  reason: string | null
  platform: string
  /** True when /proc/version mentions "microsoft" (WSL) - see src/main/wsl.ts. */
  isWSL: boolean
  /** Only meaningful on linux; null elsewhere (paste injection there uses a different mechanism). */
  xdotoolAvailable: boolean | null
}

/** Outcome of a clipboard-write + paste-injection attempt - see src/main/paste.ts. */
export interface PasteOutcome {
  copied: boolean
  pasted: boolean
  message: string
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
  pushToTalk: PushToTalkSettings
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: 'gemma-4-e2b',
  mode: 'offline',
  backend: 'mock',
  sidecar: DEFAULT_SIDECAR_SETTINGS,
  autoCopyOnCleanup: false,
  customVocabulary: [],
  hotkey: 'Ctrl+Shift+Space',
  pushToTalk: DEFAULT_PUSH_TO_TALK_SETTINGS
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
