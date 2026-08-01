import type { TransformMode } from './backend'

export type ModelId = 'gemma-4-e2b' | 'gemma-4-e4b' | 'gemma-4-12b'

/**
 * How the LiteRT-LM sidecar HTTP server is obtained:
 * - 'managed': the app spawns it itself, using `managedCommand` as a
 *   template (see `SidecarSettings.managedCommand`).
 * - 'external': the user already has a `litert-lm serve` (or compatible)
 *   process running somewhere and just gives us its base URL - we never
 *   spawn or kill it.
 */
export type SidecarMode = 'managed' | 'external'

/**
 * Which hardware backend a managed sidecar's engine actually ended up
 * running on. Observed, never requested: there is no accelerator setting -
 * the managed sidecar always runs `resources/serve_gpu.py`, which puts the
 * model on the GPU (WebGPU/Dawn -> Direct3D 12 on Windows) when the machine
 * supports it and drops to CPU by itself when it doesn't, then reports which
 * one happened on stdout (see that file's "Effective-backend reporting"
 * doc comment, `parseEffectiveBackendLine` in main/backend/sidecar.ts, and
 * `BackendStatus.effectiveAccelerator`). The UI only ever displays this
 * observed value.
 *
 * Measured on a 6 GB discrete NVIDIA GPU against the Gemma-4 E2B model: ~3.4x
 * faster decode throughput than CPU (~54 vs ~16 tok/s, warm), at the cost of
 * slower prefill and a one-time ~15s GPU shader-compile on the very first
 * run (see resources/serve_gpu.py for exact numbers and WINDOWS.md's GPU
 * section for the full writeup).
 */
export type Accelerator = 'cpu' | 'gpu'

export interface SidecarSettings {
  mode: SidecarMode
  /**
   * Command template for 'managed' mode, split on whitespace (quoted
   * segments are respected) and spawned directly - no shell involved.
   * `{port}` is substituted at spawn time; `{modelPath}` is also supported
   * for custom wrapper scripts but the real `litert-lm serve` CLI takes no
   * model-selection flag at all (verified empirically against a running
   * server) - the model is selected per-request via the JSON body's `model`
   * field (the alias it was `litert-lm import`-ed as, see
   * `ModelCatalogEntry.alias`), which is why the default template below
   * doesn't reference `{modelPath}`. `{wrapperPath}`
   * is substituted with the absolute path to `resources/serve_gpu.py` (see
   * `resolveServeGpuScriptPath` in `main/backend/gpuWrapperPath.ts`).
   * `{venvPython}`/
   * `{litertLmCli}` are substituted with the absolute paths to the
   * self-managed runtime venv's python interpreter / `litert-lm` CLI (see
   * `main/runtime/venvResolver.ts`), resolved dynamically by
   * `BackendController` on every rebuild - this is what makes the DEFAULT
   * template below deterministic without any launcher having to bake a
   * machine-specific absolute path into settings.json (contrast with a
   * hand-edited custom command, which can still just use a literal
   * absolute path directly, same as before).
   */
  managedCommand: string
  /** Base URL for 'external' mode, e.g. "http://127.0.0.1:9379" (litert-lm's default port). */
  externalUrl: string
  /** Port used to build the local URL in 'managed' mode, and substituted into managedCommand. */
  port: number
}

/**
 * The one default `managedCommand`: `resources/serve_gpu.py`, which uses the
 * GPU when the machine has a usable one and falls back to CPU by itself when
 * it doesn't, reporting which happened (see `Accelerator`'s doc comment).
 * There is deliberately no CPU variant to choose between - the wrapper
 * already picks the best available backend and tells the truth about it.
 *
 * It references `{venvPython}`/`{wrapperPath}` rather than a bare
 * `python` - those placeholders are resolved at every
 * `BackendController.rebuild()` to the self-managed runtime venv's actual
 * absolute paths (see `main/runtime/venvResolver.ts`), so a fresh install
 * (packaged app, no settings.json yet) is deterministic out of the box with
 * no launcher/seeding step required: PATH order can never pick a system
 * Python (or some other `litert-lm`) instead of the app's own venv, which
 * was a real bug this design specifically avoids re-introducing (see
 * `resolveImportCli` in `main/backend/sidecar.ts`, which still hard-errors
 * on a bare, un-placeholder'd interpreter name for any *custom* command that
 * doesn't use these placeholders). A user who hand-edits this field to a
 * literal absolute path continues to work exactly as before -
 * `{venvPython}`/`{litertLmCli}` are additive, not a requirement.
 */
export const DEFAULT_MANAGED_COMMAND =
  '"{venvPython}" "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose'

export const DEFAULT_SIDECAR_SETTINGS: SidecarSettings = {
  mode: 'managed',
  managedCommand: DEFAULT_MANAGED_COMMAND,
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
  { id: 'ControlRight', label: 'Right Ctrl' },
  { id: 'AltRight', label: 'Right Alt' },
  { id: 'F9', label: 'F9' }
]

export interface PushToTalkSettings {
  /** Master on/off switch for the global hold-to-talk overlay. No-ops if the native key-hook failed to load - see PushToTalkStatus. */
  enabled: boolean
  key: PushToTalkKeyId
  /** Whether to simulate Ctrl+V into the previously-focused app after cleanup, in addition to always copying to the clipboard. */
  autoPaste: boolean
}

/**
 * Right Ctrl rather than Right Alt, because of a Windows behaviour that
 * Blurt cannot suppress.
 *
 * Windows watches for "Alt pressed, no other key pressed, Alt released"
 * and treats it as a request to activate the focused window's menu bar,
 * which moves keyboard focus out of whatever text field the user was
 * typing in. A push-to-talk hold is exactly that pattern by construction:
 * the user holds the key, speaks, and releases, and no other key is
 * involved. So the field they wanted their dictation pasted into loses
 * focus at the moment they release, before transcription has even
 * finished.
 *
 * Blurt cannot prevent this. Its key hook (uiohook-napi) is observational
 * on Windows: the native callback always calls CallNextHookEx and never
 * consumes the event, so every Alt press and release reaches the OS
 * untouched. Confirmed by measurement as well as by reading the source.
 * Polling GetForegroundWindow during a hold shows no change, which is the
 * signature of this bug rather than evidence against it, since menu
 * activation moves focus within the foreground window instead of
 * switching windows.
 *
 * Right Ctrl carries no such meaning to the OS. Right Alt remains
 * selectable in Settings for anyone who prefers it, with the tradeoff
 * spelled out there.
 */
export const DEFAULT_PUSH_TO_TALK_SETTINGS: PushToTalkSettings = {
  enabled: true,
  key: 'ControlRight',
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
  sidecar: SidecarSettings
  autoCopyOnCleanup: boolean
  customVocabulary: string[]
  /** Electron accelerator string, e.g. "Ctrl+Shift+Space". */
  hotkey: string
  pushToTalk: PushToTalkSettings
  /**
   * Whether closing the main window leaves Blurt running in the system
   * tray instead of quitting. On by default: the whole point of the app is
   * push-to-talk from anywhere, and that only works while the process is
   * alive - so the useful state is "window gone, hotkey still armed", which
   * quitting on close makes impossible. Turn it off and the close button
   * quits outright. See src/main/tray.ts.
   */
  runInBackground: boolean
  /**
   * Whether the "still running in the tray" hint has been shown. Not
   * user-facing - a window that vanishes with no explanation reads as a
   * crash, and on Windows the tray icon is very often tucked away in the
   * overflow flyout where it won't be noticed. Shown once, on the first
   * close-to-tray ever, and never again.
   */
  hasSeenTrayHint: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  modelId: 'gemma-4-e2b',
  sidecar: DEFAULT_SIDECAR_SETTINGS,
  autoCopyOnCleanup: false,
  customVocabulary: [],
  hotkey: 'Ctrl+Shift+Space',
  pushToTalk: DEFAULT_PUSH_TO_TALK_SETTINGS,
  runInBackground: true,
  hasSeenTrayHint: false
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
