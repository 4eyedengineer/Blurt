import { EventEmitter } from 'events'
import { systemPreferences } from 'electron'
import type { PushToTalkKeyId, PushToTalkSettings } from '../../shared/types'
import { PTT_KEYCODES, isAccidentalTap } from './keyMap'
import { loadUiohook, type UiohookInstanceLike } from './uiohookLoader'
import { log } from '../log'

export interface PushToTalkAvailability {
  available: boolean
  reason: string | null
}

export interface PushToTalkControllerDeps {
  /** Overridable for tests - defaults to the real (native-module-backed) loader. */
  load?: () => ReturnType<typeof loadUiohook>
  /**
   * Overridable for tests - defaults to Electron's real, non-prompting
   * `systemPreferences.isTrustedAccessibilityClient(false)`. Only ever
   * invoked when `process.platform === 'darwin'` (see `queryAccessibility`);
   * every other platform has no such permission and never calls this at
   * all, so tests of Windows/Linux behaviour can safely leave it unset.
   */
  checkAccessibilityGranted?: () => boolean
}

export interface CanStartGlobalHookParams {
  platform: NodeJS.Platform
  /** Ignored on every platform but darwin - see PushToTalkStatus.accessibilityGranted. */
  accessibilityGranted: boolean | null
}

/**
 * Pure yes/no decision of whether it is safe to call `uIOhook.start()` right
 * now, kept as a standalone exported function (same reasoning as
 * `isAccidentalTap` in keyMap.ts) so the platform/permission branch is
 * unit-testable without an Electron runtime, a real native module, or a real
 * macOS machine underneath it.
 *
 * Only darwin gates on anything here. There, `uIOhook.start()` installs a
 * CGEventTap, which the OS refuses to create without the Accessibility
 * (TCC) permission - and calling it anyway is a known way to crash the
 * whole Electron process rather than fail cleanly (see SnosMe/uiohook-napi
 * issue #24), so this must be checked *before* start(), not discovered by
 * calling it and seeing what happens. `accessibilityGranted: null` (permission
 * state unknown/not queryable) is treated the same as `false`: refuse to
 * start, since there is no way to distinguish "safe" from "not safe" and
 * starting anyway risks the crash above. Every other platform is unaffected
 * and starts exactly as it did before this check existed.
 *
 * Not yet exercised against a real Accessibility prompt on real macOS
 * hardware - see PushToTalkController's class doc comment.
 */
export function canStartGlobalHook({
  platform,
  accessibilityGranted
}: CanStartGlobalHookParams): boolean {
  if (platform !== 'darwin') return true
  return accessibilityGranted === true
}

/**
 * Wraps uiohook-napi's global keydown/keyup stream into the three events the
 * rest of the app cares about: a configured key held long enough is a real
 * push-to-talk gesture ('hold-start' on press, 'hold-end' on release);
 * released too quickly (see PTT_DEBOUNCE_MS) is an 'accidental-tap' instead
 * (no dictation should have been started/kept). OS key-repeat (many
 * keydown events while physically held) is collapsed via an `isDown` guard
 * so 'hold-start' only ever fires once per physical press.
 *
 * Entirely optional: if the native module fails to load (see
 * uiohookLoader.ts), `getAvailability().available` is false and
 * `applySettings` becomes a no-op forever - the rest of the app must run
 * fine without this feature.
 *
 * macOS adds a second, independent gate on top of module load succeeding:
 * `uIOhook.start()` there installs a CGEventTap, which requires the
 * Accessibility (TCC) permission and is known to crash the whole Electron
 * process if attempted without it (SnosMe/uiohook-napi#24) rather than
 * failing cleanly. So on darwin, every attempt to start the hook first
 * checks `systemPreferences.isTrustedAccessibilityClient(false)` (a query,
 * never the prompting form) via `canStartGlobalHook`, and refuses to start
 * rather than risk that crash - see `startHook`, `recheckAccessibility`, and
 * `PushToTalkStatus.accessibilityGranted`. This darwin path has not been
 * exercised on real Apple Silicon hardware - it follows the documented
 * Electron/uiohook-napi behaviour, not firsthand verification, so treat any
 * real-machine report about it as high-signal.
 */
export class PushToTalkController extends EventEmitter {
  private readonly availability: PushToTalkAvailability
  private readonly uiohook: UiohookInstanceLike | null
  private readonly checkAccessibilityGranted: () => boolean

  private keyId: PushToTalkKeyId
  private enabled = false
  private hookRunning = false
  private isDown = false
  private downAt = 0
  /**
   * Cached tri-state Accessibility permission - see
   * PushToTalkStatus.accessibilityGranted. Always null off darwin. Kept as
   * a field (rather than only ever computed on demand) so
   * `recheckAccessibility`/`setAccessibilityGranted` can tell whether the
   * value actually changed and log the transition instead of logging on
   * every query.
   */
  private accessibilityGranted: boolean | null = null

  private readonly keydownHandler = (e: { keycode: number }): void => {
    if (!this.enabled) return
    if (e.keycode !== PTT_KEYCODES[this.keyId]) return
    if (this.isDown) return // OS key-repeat - already tracking this press
    this.isDown = true
    this.downAt = Date.now()
    this.emit('hold-start')
  }

  private readonly keyupHandler = (e: { keycode: number }): void => {
    if (e.keycode !== PTT_KEYCODES[this.keyId]) return
    if (!this.isDown) return
    this.isDown = false
    const holdMs = Date.now() - this.downAt
    if (isAccidentalTap(holdMs)) {
      this.emit('accidental-tap', holdMs)
    } else {
      this.emit('hold-end', holdMs)
    }
  }

  constructor(initialKeyId: PushToTalkKeyId, deps: PushToTalkControllerDeps = {}) {
    super()
    this.keyId = initialKeyId
    const load = deps.load ?? loadUiohook
    this.checkAccessibilityGranted =
      deps.checkAccessibilityGranted ??
      ((): boolean => systemPreferences.isTrustedAccessibilityClient(false))
    const result = load()
    if (result.ok) {
      this.availability = { available: true, reason: null }
      this.uiohook = result.module.uIOhook
      log.info('push-to-talk: uiohook-napi loaded')
    } else {
      this.availability = { available: false, reason: result.error }
      this.uiohook = null
      log.warn(`push-to-talk: uiohook-napi unavailable, feature disabled: ${result.error}`)
    }
    this.accessibilityGranted = this.queryAccessibility()
    if (process.platform === 'darwin') {
      log.info(
        `push-to-talk: macOS Accessibility permission currently ${this.accessibilityGranted ? 'granted' : 'not granted'}`
      )
    }
  }

  getAvailability(): PushToTalkAvailability {
    return this.availability
  }

  /**
   * Current tri-state Accessibility permission, for Settings to display -
   * see PushToTalkStatus.accessibilityGranted. Always freshly queried
   * (cheap and non-prompting on darwin, an immediate `null` everywhere
   * else) rather than served from a possibly-stale cache: the user can flip
   * this in System Settings at any time outside the app's control, and a
   * stale "not granted" would be exactly the kind of state-vs-intent lie
   * Settings must not tell. Does not attempt to start the hook by itself -
   * only `recheckAccessibility` does that; a passive status read should
   * never have the side effect of arming a global key hook.
   */
  getAccessibilityStatus(): boolean | null {
    this.setAccessibilityGranted(this.queryAccessibility())
    return this.accessibilityGranted
  }

  /**
   * Re-queries the macOS Accessibility permission and starts the hook if it
   * can now start. Exists because granting the permission in System
   * Settings does not retroactively arm a hook that already tried to start
   * and was refused - nothing calls `uIOhook.start()` again on its own, so
   * something has to notice the user came back from System Settings and try
   * again. Called from pushToTalkIpc.ts right after prompting via
   * `isTrustedAccessibilityClient(true)` (see that file's `requestAccessibility`
   * handler). Reports the freshly-queried state either way. A no-op beyond
   * that reporting on every platform but darwin, since there is nothing to
   * re-check anywhere else.
   */
  recheckAccessibility(): boolean | null {
    if (process.platform !== 'darwin') return this.accessibilityGranted
    if (this.enabled && !this.hookRunning) {
      this.startHook() // re-queries internally and starts if now allowed
    } else {
      this.setAccessibilityGranted(this.queryAccessibility())
    }
    return this.accessibilityGranted
  }

  /** Applies fresh settings, starting/stopping the underlying OS-level hook as needed. */
  /**
   * Takes only the two fields it acts on rather than the whole
   * `PushToTalkSettings`. What happens to the dictated text afterwards -
   * auto-paste, trailing space - is the overlay controller's business, and
   * asking for those here meant every new field in that interface broke this
   * signature and every one of its call sites for no behavioural reason.
   */
  applySettings(settings: Pick<PushToTalkSettings, 'enabled' | 'key'>): void {
    this.keyId = settings.key
    const nextEnabled = settings.enabled && this.availability.available
    if (nextEnabled && !this.hookRunning) {
      this.startHook()
    } else if (!nextEnabled && this.hookRunning) {
      this.stopHook()
    }
    this.enabled = nextEnabled
  }

  /**
   * Live, non-prompting query of the current Accessibility permission -
   * null (the concept doesn't apply) off darwin, which never touches
   * `checkAccessibilityGranted`/`systemPreferences` at all.
   */
  private queryAccessibility(): boolean | null {
    if (process.platform !== 'darwin') return null
    try {
      return this.checkAccessibilityGranted()
    } catch (err) {
      // This module's whole contract is that push-to-talk is optional and
      // can never take the app down with it - that is why `loadUiohook`
      // exists at all rather than a bare `import`. The same rule has to
      // apply here: this runs from the constructor, `new
      // PushToTalkController(...)` in index.ts is not wrapped in a
      // try/catch, and Electron's `systemPreferences` API surface is
      // platform-conditional, so an unguarded throw here would turn a
      // missing optional feature into a failed app launch.
      //
      // Returning null (rather than false) is the honest answer: the
      // permission state is genuinely unknown, not known-denied.
      // `canStartGlobalHook` already refuses to start on null, so this
      // fails safe into "push-to-talk off, app fine" instead of risking
      // the CGEventTap crash.
      log.warn(
        `push-to-talk: could not query macOS Accessibility permission, treating as unknown: ${err instanceof Error ? err.message : String(err)}`
      )
      return null
    }
  }

  /** Updates the cached permission, logging only when it actually changes (every transition is logged). */
  private setAccessibilityGranted(next: boolean | null): void {
    if (next === this.accessibilityGranted) return
    log.info(
      `push-to-talk: macOS Accessibility permission changed: ${String(this.accessibilityGranted)} -> ${String(next)}`
    )
    this.accessibilityGranted = next
  }

  private startHook(): void {
    if (!this.uiohook) return
    this.setAccessibilityGranted(this.queryAccessibility())
    const canStart = canStartGlobalHook({
      platform: process.platform,
      accessibilityGranted: this.accessibilityGranted
    })
    if (!canStart) {
      log.warn(
        'push-to-talk: hook not started - macOS Accessibility permission not granted (System Settings > Privacy & Security > Accessibility). Use "Open System Settings" in Settings > Push to talk to grant it and retry.'
      )
      return
    }
    this.uiohook.on('keydown', this.keydownHandler)
    this.uiohook.on('keyup', this.keyupHandler)
    try {
      this.uiohook.start()
      this.hookRunning = true
      log.info(`push-to-talk: hook started (key=${this.keyId})`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`push-to-talk: failed to start hook: ${message}`)
    }
  }

  private stopHook(): void {
    if (!this.uiohook) return
    try {
      this.uiohook.stop()
      log.info('push-to-talk: hook stopped')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log.error(`push-to-talk: failed to stop hook: ${message}`)
    }
    this.uiohook.removeListener('keydown', this.keydownHandler)
    this.uiohook.removeListener('keyup', this.keyupHandler)
    this.hookRunning = false
    this.isDown = false
  }

  /** Call on app quit. */
  dispose(): void {
    if (this.hookRunning) this.stopHook()
  }
}
