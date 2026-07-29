import type { PushToTalkKeyId } from '../../shared/types'

/**
 * uiohook-napi keycodes for the keys we let the user pick in Settings (see
 * `UiohookKey` in node_modules/uiohook-napi/dist/index.d.ts - AltRight
 * 0x0e38, CtrlRight 0x0e1d, F9 0x0043). Hardcoded here rather than imported
 * from 'uiohook-napi' directly: importing that package eagerly dlopen()s its
 * native addon (see uiohookLoader.ts), which can throw synchronously on
 * platforms/environments without a compatible prebuild. Keeping the mapping
 * as plain data means it stays usable - and unit-testable - even when the
 * native module itself can't load.
 */
export const PTT_KEYCODES: Record<PushToTalkKeyId, number> = {
  AltRight: 0x0e38,
  ControlRight: 0x0e1d,
  F9: 0x0043
}

/** Holds shorter than this are treated as an accidental tap and discarded (no cleanup/paste). */
export const PTT_DEBOUNCE_MS = 250

/** Pure predicate over a measured hold duration - kept separate from the controller for easy unit testing. */
export function isAccidentalTap(holdMs: number): boolean {
  return holdMs < PTT_DEBOUNCE_MS
}

/** Reverse lookup, mostly useful for tests/debugging. Returns null for an unrecognized keycode. */
export function keyIdForKeycode(keycode: number): PushToTalkKeyId | null {
  const entry = (Object.entries(PTT_KEYCODES) as Array<[PushToTalkKeyId, number]>).find(
    ([, code]) => code === keycode
  )
  return entry ? entry[0] : null
}
