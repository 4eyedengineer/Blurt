import { describe, expect, it } from 'vitest'
import {
  getRuntimeBaseDir,
  isRuntimeManagedPlatform,
  isVenvHealthy,
  venvPathsFor
} from './venvResolver'

describe('venvPathsFor', () => {
  it('uses Scripts\\*.exe on win32', () => {
    const paths = venvPathsFor('C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv', 'win32')
    expect(paths.pythonExe).toBe(
      'C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv\\Scripts\\python.exe'
    )
    expect(paths.litertLmExe).toBe(
      'C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv\\Scripts\\litert-lm.exe'
    )
  })

  it('uses bin/* with no suffix on posix platforms', () => {
    const paths = venvPathsFor('/home/user/.local/venv', 'linux')
    expect(paths.pythonExe).toBe('/home/user/.local/venv/bin/python')
    expect(paths.litertLmExe).toBe('/home/user/.local/venv/bin/litert-lm')
  })

  it('uses bin/* with no suffix on darwin, same as other posix platforms', () => {
    const paths = venvPathsFor('/Users/testuser/Library/Application Support/Blurt/venv', 'darwin')
    expect(paths.pythonExe).toBe(
      '/Users/testuser/Library/Application Support/Blurt/venv/bin/python'
    )
    expect(paths.litertLmExe).toBe(
      '/Users/testuser/Library/Application Support/Blurt/venv/bin/litert-lm'
    )
  })
})

describe('isRuntimeManagedPlatform', () => {
  it('is true for win32 and darwin', () => {
    expect(isRuntimeManagedPlatform('win32')).toBe(true)
    expect(isRuntimeManagedPlatform('darwin')).toBe(true)
  })

  it('is false for linux and other platforms', () => {
    expect(isRuntimeManagedPlatform('linux')).toBe(false)
    expect(isRuntimeManagedPlatform('freebsd')).toBe(false)
    expect(isRuntimeManagedPlatform('aix')).toBe(false)
  })
})

describe('getRuntimeBaseDir', () => {
  it('joins LOCALAPPDATA with Blurt on win32', () => {
    expect(
      getRuntimeBaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local' })
    ).toBe('C:\\Users\\testuser\\AppData\\Local\\Blurt')
  })

  it('throws when LOCALAPPDATA is unset on win32', () => {
    expect(() => getRuntimeBaseDir('win32', {})).toThrow(/LOCALAPPDATA/)
  })

  it('joins HOME with Library/Application Support/Blurt on darwin', () => {
    expect(getRuntimeBaseDir('darwin', { HOME: '/Users/testuser' })).toBe(
      '/Users/testuser/Library/Application Support/Blurt'
    )
  })

  it('throws when HOME is unset on darwin', () => {
    expect(() => getRuntimeBaseDir('darwin', {})).toThrow(/HOME/)
  })

  it('throws a loud, explicit error for a platform this app does not manage a venv on', () => {
    expect(() => getRuntimeBaseDir('linux', { HOME: '/home/testuser' })).toThrow(
      /[Uu]nsupported platform/
    )
  })
})

describe('isVenvHealthy', () => {
  it('is false when the paths point nowhere real', () => {
    const paths = venvPathsFor('/definitely/not/a/real/path/venv', 'linux')
    expect(isVenvHealthy(paths)).toBe(false)
  })
})
