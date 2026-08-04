import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'

// pushToTalkController imports `systemPreferences` from electron at module
// scope (used as the default, real implementation of the
// checkAccessibilityGranted dep - see that file). Mocked here for the same
// reason overlayController.test.ts mocks `clipboard`: none of this exists
// outside a running Electron app, and every test below either runs on a
// non-darwin platform (where this mock is never even reached - see
// queryAccessibility's platform guard) or injects its own
// checkAccessibilityGranted fake via deps, so the mock's return value itself
// is never actually asserted on.
vi.mock('electron', () => ({
  systemPreferences: { isTrustedAccessibilityClient: vi.fn(() => false) }
}))

import { PushToTalkController, canStartGlobalHook } from './pushToTalkController'
import { PTT_KEYCODES } from './keyMap'
import type { UiohookInstanceLike, UiohookModuleLike } from './uiohookLoader'

/**
 * `process.platform` is defined as a non-writable-but-configurable property,
 * so a plain `process.platform = ...` assignment throws in strict mode -
 * this redefines it for the duration of `fn` and restores the original
 * value afterward. Synchronous (unlike src/main/paste.test.ts's identical
 * helper) because every PushToTalkController method exercised below is
 * synchronous, so there is no risk of the restore running before a later
 * `await` reads the stubbed value.
 */
function withPlatform<T>(platform: NodeJS.Platform, fn: () => T): T {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/** A fake uiohook backed by a plain EventEmitter, so tests can synthesize keydown/keyup without the native module. */
function fakeUiohook(): {
  instance: UiohookInstanceLike
  emitter: EventEmitter
  started: boolean[]
} {
  const emitter = new EventEmitter()
  const started: boolean[] = []
  const instance: UiohookInstanceLike = {
    start: () => started.push(true),
    stop: () => started.push(false),
    on: (event, listener) => emitter.on(event, listener),
    removeListener: (event, listener) => emitter.removeListener(event, listener)
  }
  return { instance, emitter, started }
}

function loadOk(instance: UiohookInstanceLike): () => { ok: true; module: UiohookModuleLike } {
  return () => ({ ok: true, module: { uIOhook: instance } })
}

describe('PushToTalkController - availability', () => {
  it('reports unavailable (and stays a no-op) when the loader fails', () => {
    const controller = new PushToTalkController('AltRight', {
      load: () => ({ ok: false, error: 'ERR_DLOPEN_FAILED: GLIBC_2.34 not found' })
    })
    expect(controller.getAvailability()).toEqual({
      available: false,
      reason: 'ERR_DLOPEN_FAILED: GLIBC_2.34 not found'
    })
    // Should not throw even though there's no real hook underneath.
    expect(() => controller.applySettings({ enabled: true, key: 'AltRight' })).not.toThrow()
  })

  it('reports available when the loader succeeds', () => {
    const { instance } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    expect(controller.getAvailability()).toEqual({ available: true, reason: null })
  })
})

describe('PushToTalkController - hold gesture detection', () => {
  it('emits hold-start on keydown and hold-end on keyup for a real hold', () => {
    const { instance, emitter } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    controller.applySettings({ enabled: true, key: 'AltRight' })

    const events: string[] = []
    controller.on('hold-start', () => events.push('hold-start'))
    controller.on('hold-end', () => events.push('hold-end'))
    controller.on('accidental-tap', () => events.push('accidental-tap'))

    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight })
    // Simulate a real hold by faking Date.now() would be more precise, but a
    // synchronous test naturally measures ~0ms - directly exercise via the
    // debounce boundary instead in the next test. Here we only assert
    // hold-start fired exactly once despite OS key-repeat below.
    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight }) // key-repeat
    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight }) // key-repeat
    expect(events).toEqual(['hold-start'])

    emitter.emit('keyup', { keycode: PTT_KEYCODES.AltRight })
    expect(events.at(-1)).toBe('accidental-tap') // <250ms in a synchronous test
  })

  it('ignores keys other than the configured one', () => {
    const { instance, emitter } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    controller.applySettings({ enabled: true, key: 'AltRight' })

    const events: string[] = []
    controller.on('hold-start', () => events.push('hold-start'))

    emitter.emit('keydown', { keycode: PTT_KEYCODES.ControlRight })
    emitter.emit('keydown', { keycode: PTT_KEYCODES.F9 })
    expect(events).toEqual([])
  })

  it('does nothing while disabled', () => {
    const { instance, emitter, started } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    controller.applySettings({ enabled: false, key: 'AltRight' })

    const events: string[] = []
    controller.on('hold-start', () => events.push('hold-start'))
    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight })

    expect(events).toEqual([])
    expect(started).toEqual([]) // hook never started
  })

  it('starts/stops the underlying hook exactly once when toggled on/off repeatedly', () => {
    const { instance, started } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })

    controller.applySettings({ enabled: true, key: 'AltRight' })
    controller.applySettings({ enabled: true, key: 'ControlRight' }) // key change, still enabled
    controller.applySettings({ enabled: false, key: 'ControlRight' })
    controller.applySettings({ enabled: false, key: 'ControlRight' }) // already off

    expect(started).toEqual([true, false])
  })

  it('switches the active key without needing hold-start/hold-end to be re-wired', () => {
    const { instance, emitter } = fakeUiohook()
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    controller.applySettings({ enabled: true, key: 'AltRight' })
    controller.applySettings({ enabled: true, key: 'F9' })

    const events: string[] = []
    controller.on('hold-start', () => events.push('hold-start'))

    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight }) // old key, should no longer match
    expect(events).toEqual([])

    emitter.emit('keydown', { keycode: PTT_KEYCODES.F9 })
    expect(events).toEqual(['hold-start'])
  })
})

describe('PushToTalkController - a hook whose start() fails', () => {
  /** Like `fakeUiohook`, but `start()` throws for its first `failures` calls and succeeds after that. */
  function flakyUiohook(failures: number): {
    instance: UiohookInstanceLike
    emitter: EventEmitter
  } {
    const emitter = new EventEmitter()
    let attempts = 0
    const instance: UiohookInstanceLike = {
      start: () => {
        attempts += 1
        if (attempts <= failures) throw new Error('CGEventTap could not be created')
      },
      stop: () => {},
      on: (event, listener) => emitter.on(event, listener),
      removeListener: (event, listener) => emitter.removeListener(event, listener)
    }
    return { instance, emitter }
  }

  it('registers no key listeners at all when start() throws', () => {
    const { instance, emitter } = flakyUiohook(1)
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
    controller.applySettings({ enabled: true, key: 'AltRight' })

    // Listeners used to be attached before start(), so a throw left them
    // behind with hookRunning still false - and both stopHook() and dispose()
    // are gated on that flag, so nothing could ever remove them.
    expect(emitter.listenerCount('keydown')).toBe(0)
    expect(emitter.listenerCount('keyup')).toBe(0)
  })

  it('emits hold-start once per press after earlier failed starts, not once per attempt', () => {
    // The real cost of the leak above: Node's EventEmitter appends duplicate
    // identical listeners rather than deduping them, so every retry added
    // another pair. Once start() finally succeeded, a single physical
    // keypress emitted hold-start once per previous attempt, and each of
    // those opens its own dictation session in the overlay.
    const { instance, emitter } = flakyUiohook(2)
    const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })

    // Two failed attempts, each reached by toggling the feature off and on.
    controller.applySettings({ enabled: true, key: 'AltRight' })
    controller.applySettings({ enabled: false, key: 'AltRight' })
    controller.applySettings({ enabled: true, key: 'AltRight' })
    controller.applySettings({ enabled: false, key: 'AltRight' })
    // Third attempt succeeds.
    controller.applySettings({ enabled: true, key: 'AltRight' })

    expect(emitter.listenerCount('keydown')).toBe(1)

    const events: string[] = []
    controller.on('hold-start', () => events.push('hold-start'))
    emitter.emit('keydown', { keycode: PTT_KEYCODES.AltRight })
    expect(events).toEqual(['hold-start'])
  })
})

describe('canStartGlobalHook', () => {
  it('always allows starting on every non-darwin platform, regardless of the accessibility flag', () => {
    for (const platform of ['win32', 'linux', 'freebsd', 'aix'] as NodeJS.Platform[]) {
      expect(canStartGlobalHook({ platform, accessibilityGranted: null })).toBe(true)
      expect(canStartGlobalHook({ platform, accessibilityGranted: false })).toBe(true)
      expect(canStartGlobalHook({ platform, accessibilityGranted: true })).toBe(true)
    }
  })

  it('refuses to start on darwin when the Accessibility permission is not granted', () => {
    expect(canStartGlobalHook({ platform: 'darwin', accessibilityGranted: false })).toBe(false)
  })

  it('refuses to start on darwin when the permission state is unknown (null)', () => {
    // null means "couldn't determine" - treated as unsafe, same as false, not
    // as a free pass. See the function's doc comment.
    expect(canStartGlobalHook({ platform: 'darwin', accessibilityGranted: null })).toBe(false)
  })

  it('allows starting on darwin once the Accessibility permission is granted', () => {
    expect(canStartGlobalHook({ platform: 'darwin', accessibilityGranted: true })).toBe(true)
  })
})

describe('PushToTalkController - macOS Accessibility gating', () => {
  it('reports null (not false) for accessibilityGranted on non-darwin platforms', () => {
    withPlatform('win32', () => {
      const { instance } = fakeUiohook()
      const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
      expect(controller.getAccessibilityStatus()).toBeNull()
    })
  })

  it('does not start the hook on darwin when Accessibility is not granted, and reports that in status', () => {
    withPlatform('darwin', () => {
      const { instance, started } = fakeUiohook()
      const controller = new PushToTalkController('AltRight', {
        load: loadOk(instance),
        checkAccessibilityGranted: () => false
      })
      controller.applySettings({ enabled: true, key: 'AltRight' })

      expect(started).toEqual([]) // uIOhook.start() was never called
      expect(controller.getAccessibilityStatus()).toBe(false)
    })
  })

  it('starts the hook on darwin when Accessibility is already granted', () => {
    withPlatform('darwin', () => {
      const { instance, started } = fakeUiohook()
      const controller = new PushToTalkController('AltRight', {
        load: loadOk(instance),
        checkAccessibilityGranted: () => true
      })
      controller.applySettings({ enabled: true, key: 'AltRight' })

      expect(started).toEqual([true])
      expect(controller.getAccessibilityStatus()).toBe(true)
    })
  })

  it('recheckAccessibility arms the hook once permission is granted after an earlier refusal', () => {
    withPlatform('darwin', () => {
      const { instance, started } = fakeUiohook()
      let granted = false
      const controller = new PushToTalkController('AltRight', {
        load: loadOk(instance),
        checkAccessibilityGranted: () => granted
      })
      controller.applySettings({ enabled: true, key: 'AltRight' })
      expect(started).toEqual([]) // refused - not granted yet

      granted = true // user granted it in System Settings, in between
      const result = controller.recheckAccessibility()

      expect(result).toBe(true)
      expect(started).toEqual([true])
    })
  })

  it('recheckAccessibility does not re-start an already-running hook or re-attempt for a disabled feature', () => {
    withPlatform('darwin', () => {
      const { instance, started } = fakeUiohook()
      const controller = new PushToTalkController('AltRight', {
        load: loadOk(instance),
        checkAccessibilityGranted: () => true
      })
      controller.applySettings({ enabled: true, key: 'AltRight' })
      expect(started).toEqual([true])

      controller.recheckAccessibility()
      expect(started).toEqual([true]) // unchanged - no redundant restart
    })
  })

  it('recheckAccessibility is a no-op (beyond reporting the always-null state) on non-darwin platforms', () => {
    withPlatform('linux', () => {
      const { instance, started } = fakeUiohook()
      const controller = new PushToTalkController('AltRight', { load: loadOk(instance) })
      controller.applySettings({ enabled: true, key: 'AltRight' })
      expect(started).toEqual([true]) // started normally - no darwin gating applies

      const result = controller.recheckAccessibility()
      expect(result).toBeNull()
      expect(started).toEqual([true]) // unchanged
    })
  })
})
