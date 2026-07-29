import { describe, expect, it } from 'vitest'
import { detectWSL, isWSLVersionString } from './wsl'

describe('isWSLVersionString', () => {
  it('matches a real WSL2 /proc/version string', () => {
    expect(
      isWSLVersionString(
        'Linux version 6.18.33.2-microsoft-standard-WSL2 (root@f1bbfb02316b) (gcc ...)'
      )
    ).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isWSLVersionString('...MICROSOFT...')).toBe(true)
  })

  it('does not match a plain Linux /proc/version string', () => {
    expect(
      isWSLVersionString('Linux version 6.8.0-generic (buildd@lcy02) (gcc (Ubuntu 13.2.0))')
    ).toBe(false)
  })
})

describe('detectWSL', () => {
  it('returns false immediately on non-linux platforms without reading anything', () => {
    let read = false
    const result = detectWSL('win32', () => {
      read = true
      return 'microsoft'
    })
    expect(result).toBe(false)
    expect(read).toBe(false)
  })

  it('returns true on linux when /proc/version mentions microsoft', () => {
    expect(detectWSL('linux', () => 'Linux version ...-microsoft-standard-WSL2 ...')).toBe(true)
  })

  it('returns false on linux when /proc/version does not mention microsoft', () => {
    expect(detectWSL('linux', () => 'Linux version 6.8.0-generic ...')).toBe(false)
  })

  it('returns false (not throw) if reading /proc/version fails', () => {
    expect(
      detectWSL('linux', () => {
        throw new Error('ENOENT')
      })
    ).toBe(false)
  })
})
