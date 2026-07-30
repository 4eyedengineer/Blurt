import type { TransformMode } from './backend'

export type ModelId = 'gemma-4-e2b' | 'gemma-4-e4b' | 'gemma-4-12b'

export type BackendMode = 'offline' | 'cloud'

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
 * Which hardware backend a *managed* sidecar should run the model on.
 *
 * The pip `litert-lm serve` CLI has no `--backend` flag at all - it always
 * loads the model on whatever its `.litertlm` metadata's
 * `backend_constraint` says (which is "cpu" for every section of the
 * Gemma-4 `litert-community` files, including their optional audio/vision
 * adapters). Empirically, though, the *main* prefill/decode graph runs
 * fine on GPU (WebGPU/Dawn -> Direct3D 12 on Windows) despite that
 * constraint - measured on an RTX 3060 Laptop GPU against the Gemma-4 E2B
 * model: ~3.4x faster decode throughput than CPU (~54 vs ~16 tok/s, warm),
 * at the cost of slower prefill and a one-time ~15s GPU shader-compile on
 * the very first run (see resources/serve_gpu.py's doc comment for exact
 * numbers/commands and WINDOWS.md's GPU section for the full writeup).
 *
 * 'gpu' only changes anything for `mode: 'managed'` - it's implemented by
 * swapping in `resources/serve_gpu.py` (a thin wrapper around the same
 * `litert-lm serve`, see that file) as the managed command instead of the
 * bare `litert-lm` binary; 'external' mode is whatever backend the user's
 * already-running server happens to be using, out of this app's control.
 * If GPU initialization genuinely fails (no compatible adapter), the
 * wrapper falls back to CPU on its own for the rest of that process's
 * lifetime - see serve_gpu.py's fallback logic - so picking 'gpu' here is
 * safe even on a machine that turns out not to support it, just slower to
 * report ready on its very first request.
 */
export type Accelerator = 'cpu' | 'gpu'

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
   * the default template below doesn't reference `{modelPath}`. `{wrapperPath}`
   * is substituted with the absolute path to `resources/serve_gpu.py` (see
   * `resolveServeGpuScriptPath` in `main/backend/gpuWrapperPath.ts`) -
   * only meaningful for the `accelerator: 'gpu'` default template below,
   * but available to any custom template that wants it. `{venvPython}`/
   * `{litertLmCli}` are substituted with the absolute paths to the
   * self-managed runtime venv's python interpreter / `litert-lm` CLI (see
   * `main/runtime/venvResolver.ts`), resolved dynamically by
   * `BackendController` on every rebuild - this is what makes the DEFAULT
   * templates below deterministic without any launcher having to bake a
   * machine-specific absolute path into settings.json (contrast with a
   * hand-edited custom command, which can still just use a literal
   * absolute path directly, same as before).
   */
  managedCommand: string
  /** Base URL for 'external' mode, e.g. "http://127.0.0.1:9379" (litert-lm's default port). */
  externalUrl: string
  /** Port used to build the local URL in 'managed' mode, and substituted into managedCommand. */
  port: number
  /** See `Accelerator`'s doc comment. Only affects `mode: 'managed'`. */
  accelerator: Accelerator
}

/**
 * Default `managedCommand` for each accelerator - see `Accelerator`'s doc
 * comment. Selecting an accelerator in Settings rewrites `managedCommand` to
 * the matching entry here, so what's shown in the (still freely editable)
 * command box always matches what's actually configured.
 *
 * Both templates reference `{venvPython}`/`{litertLmCli}` rather than a bare
 * `python`/`litert-lm` - those placeholders are resolved at every
 * `BackendController.rebuild()` to the self-managed runtime venv's actual
 * absolute paths (see `main/runtime/venvResolver.ts`), so a fresh install
 * (packaged app, no settings.json yet) is deterministic out of the box with
 * no launcher/seeding step required: PATH order can never pick a system
 * Python (or some other `litert-lm`) instead of the app's own venv, which
 * was a real bug this design specifically avoids re-introducing (see
 * `resolveImportCli` in `main/backend/sidecar.ts`, which still hard-errors
 * on a bare, un-placeholder'd interpreter name for any *custom* command that
 * doesn't use these placeholders). A user who hand-edits this field to a
 * literal absolute path (as `Start-Eloquent.ps1`/`run.sh` still do when they
 * seed a fresh settings.json of their own, for the dev path) continues to
 * work exactly as before - `{venvPython}`/`{litertLmCli}` are additive, not
 * a requirement.
 */
export const MANAGED_COMMAND_BY_ACCELERATOR: Record<Accelerator, string> = {
  cpu: '"{litertLmCli}" serve --host 127.0.0.1 --port {port}',
  gpu: '"{venvPython}" "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose'
}

export const DEFAULT_SIDECAR_SETTINGS: SidecarSettings = {
  mode: 'managed',
  managedCommand: MANAGED_COMMAND_BY_ACCELERATOR.gpu,
  externalUrl: 'http://127.0.0.1:9379',
  port: 9379,
  accelerator: 'gpu'
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
