import { describe, expect, it } from 'vitest'
import { PTT_KEY_OPTIONS, pttKeyLabel } from './types'

describe('pttKeyLabel', () => {
  it('returns Right Ctrl for ControlRight on win32 - byte-identical to the pre-macOS wording', () => {
    expect(pttKeyLabel('ControlRight', 'win32')).toBe('Right Ctrl')
  })

  it('returns Right Alt for AltRight on win32 - byte-identical to the pre-macOS wording', () => {
    expect(pttKeyLabel('AltRight', 'win32')).toBe('Right Alt')
  })

  it('returns F9 for F9 on win32', () => {
    expect(pttKeyLabel('F9', 'win32')).toBe('F9')
  })

  it('returns Right Ctrl for ControlRight on linux - byte-identical to the pre-macOS wording', () => {
    expect(pttKeyLabel('ControlRight', 'linux')).toBe('Right Ctrl')
  })

  it('returns Right Alt for AltRight on linux - byte-identical to the pre-macOS wording', () => {
    expect(pttKeyLabel('AltRight', 'linux')).toBe('Right Alt')
  })

  it('returns F9 for F9 on linux', () => {
    expect(pttKeyLabel('F9', 'linux')).toBe('F9')
  })

  it('returns Right Control for ControlRight on darwin, matching the physical Mac keyboard label', () => {
    expect(pttKeyLabel('ControlRight', 'darwin')).toBe('Right Control')
  })

  it('returns Right Option for AltRight on darwin, matching the physical Mac keyboard label', () => {
    expect(pttKeyLabel('AltRight', 'darwin')).toBe('Right Option')
  })

  it('returns F9 for F9 on darwin - unchanged, there is no Mac-specific label for F9', () => {
    expect(pttKeyLabel('F9', 'darwin')).toBe('F9')
  })

  // Settings renders one radio per PTT_KEY_OPTIONS entry and gets its text
  // solely from pttKeyLabel, so the two have to stay in step. The exhaustive
  // switch already makes a missing case a compile error, but that only fires
  // once the id is added to the union - this catches the case where the
  // options list and the label function drift apart for any other reason,
  // on every platform Settings can run on.
  it.each(['win32', 'linux', 'darwin'])(
    'gives every offered key a non-empty label on %s',
    (platform) => {
      for (const keyId of PTT_KEY_OPTIONS) {
        expect(pttKeyLabel(keyId, platform).trim()).not.toBe('')
      }
    }
  )

  it('offers exactly the keys the push-to-talk hook knows how to listen for', () => {
    expect(PTT_KEY_OPTIONS).toEqual(['ControlRight', 'AltRight', 'F9'])
  })
})
