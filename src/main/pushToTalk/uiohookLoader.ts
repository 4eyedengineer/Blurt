/**
 * Minimal shape of the 'uiohook-napi' module surface this app actually uses,
 * typed by hand so the rest of the code never needs a direct `import` (which
 * would make the native addon's dlopen() a load-time hard dependency of this
 * whole module graph rather than something we can catch).
 */
export interface UiohookKeyboardEventLike {
  keycode: number
}

export interface UiohookInstanceLike {
  start(): void
  stop(): void
  on(event: 'keydown' | 'keyup', listener: (e: UiohookKeyboardEventLike) => void): unknown
  removeListener(
    event: 'keydown' | 'keyup',
    listener: (e: UiohookKeyboardEventLike) => void
  ): unknown
}

export interface UiohookModuleLike {
  uIOhook: UiohookInstanceLike
}

export type UiohookLoadResult =
  { ok: true; module: UiohookModuleLike } | { ok: false; error: string }

/**
 * Loads uiohook-napi defensively. `node_modules/uiohook-napi/dist/index.js`
 * dlopen()s a native addon unconditionally at require-time, so a bare
 * require can throw synchronously if no compatible prebuild exists for this
 * platform/arch/glibc combination.
 *
 * Verified empirically in this project's own dev container: the shipped
 * `prebuilds/linux-x64/uiohook-napi.node` requires glibc >= 2.34, but this
 * container has glibc 2.31 (same class of issue as the Rollup native-binary
 * note elsewhere in this repo) - `require('uiohook-napi')` throws
 * `ERR_DLOPEN_FAILED: ... version 'GLIBC_2.34' not found`, reproduced
 * identically under Electron's own bundled Node via
 * `ELECTRON_RUN_AS_NODE=1 electron -e "require('uiohook-napi')"`. Every
 * caller of this function must treat push-to-talk as entirely optional
 * based on the result - see PushToTalkController and the "Known
 * limitations" section of README.md.
 */
export function loadUiohook(): UiohookLoadResult {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see doc comment: must be catchable, not a static import
    const mod = require('uiohook-napi') as UiohookModuleLike
    if (!mod?.uIOhook) {
      return { ok: false, error: 'uiohook-napi loaded but did not export uIOhook' }
    }
    return { ok: true, module: mod }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
