import { EventEmitter } from 'events'
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
 */
export class PushToTalkController extends EventEmitter {
  private readonly availability: PushToTalkAvailability
  private readonly uiohook: UiohookInstanceLike | null

  private keyId: PushToTalkKeyId
  private enabled = false
  private hookRunning = false
  private isDown = false
  private downAt = 0

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
  }

  getAvailability(): PushToTalkAvailability {
    return this.availability
  }

  /** Applies fresh settings, starting/stopping the underlying OS-level hook as needed. */
  applySettings(settings: PushToTalkSettings): void {
    this.keyId = settings.key
    const nextEnabled = settings.enabled && this.availability.available
    if (nextEnabled && !this.hookRunning) {
      this.startHook()
    } else if (!nextEnabled && this.hookRunning) {
      this.stopHook()
    }
    this.enabled = nextEnabled
  }

  private startHook(): void {
    if (!this.uiohook) return
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
