import { describe, expect, it } from 'vitest'
import { PTT_DEBOUNCE_MS, PTT_KEYCODES, isAccidentalTap, keyIdForKeycode } from './keyMap'

describe('PTT_KEYCODES', () => {
  it('matches the real uiohook-napi UiohookKey values (see doc comment)', () => {
    // Cross-checked against node_modules/uiohook-napi/dist/index.d.ts.
    expect(PTT_KEYCODES.AltRight).toBe(0x0e38)
    expect(PTT_KEYCODES.ControlRight).toBe(0x0e1d)
    expect(PTT_KEYCODES.F9).toBe(0x0043)
  })

  it('has a unique keycode per key id', () => {
    const codes = Object.values(PTT_KEYCODES)
    expect(new Set(codes).size).toBe(codes.length)
  })
})

describe('isAccidentalTap', () => {
  it('treats anything shorter than the debounce threshold as an accidental tap', () => {
    expect(isAccidentalTap(0)).toBe(true)
    expect(isAccidentalTap(1)).toBe(true)
    expect(isAccidentalTap(PTT_DEBOUNCE_MS - 1)).toBe(true)
  })

  it('treats the threshold itself and anything longer as a real hold', () => {
    expect(isAccidentalTap(PTT_DEBOUNCE_MS)).toBe(false)
    expect(isAccidentalTap(PTT_DEBOUNCE_MS + 1)).toBe(false)
    expect(isAccidentalTap(5000)).toBe(false)
  })
})

describe('keyIdForKeycode', () => {
  it('resolves a known keycode back to its key id', () => {
    expect(keyIdForKeycode(0x0e38)).toBe('AltRight')
    expect(keyIdForKeycode(0x0e1d)).toBe('ControlRight')
    expect(keyIdForKeycode(0x0043)).toBe('F9')
  })

  it('returns null for an unrecognized keycode', () => {
    expect(keyIdForKeycode(0xdead)).toBeNull()
  })
})
