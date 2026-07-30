import { describe, expect, it } from 'vitest'
import { getRuntimeBaseDir, isVenvHealthy, venvPathsFor } from './venvResolver'

describe('venvPathsFor', () => {
  it('uses Scripts\\*.exe on win32', () => {
    const paths = venvPathsFor('C:\\Users\\modte\\AppData\\Local\\WindowsEloquent\\venv', 'win32')
    expect(paths.pythonExe).toBe(
      'C:\\Users\\modte\\AppData\\Local\\WindowsEloquent\\venv\\Scripts\\python.exe'
    )
    expect(paths.litertLmExe).toBe(
      'C:\\Users\\modte\\AppData\\Local\\WindowsEloquent\\venv\\Scripts\\litert-lm.exe'
    )
  })

  it('uses bin/* with no suffix on posix platforms', () => {
    const paths = venvPathsFor('/home/user/.local/venv', 'linux')
    expect(paths.pythonExe).toBe('/home/user/.local/venv/bin/python')
    expect(paths.litertLmExe).toBe('/home/user/.local/venv/bin/litert-lm')
  })
})

describe('getRuntimeBaseDir', () => {
  it('joins LOCALAPPDATA with WindowsEloquent', () => {
    expect(getRuntimeBaseDir({ LOCALAPPDATA: 'C:\\Users\\modte\\AppData\\Local' })).toContain(
      'WindowsEloquent'
    )
  })

  it('throws when LOCALAPPDATA is unset', () => {
    expect(() => getRuntimeBaseDir({})).toThrow(/LOCALAPPDATA/)
  })
})

describe('isVenvHealthy', () => {
  it('is false when the paths point nowhere real', () => {
    const paths = venvPathsFor('/definitely/not/a/real/path/venv', 'linux')
    expect(isVenvHealthy(paths)).toBe(false)
  })
})
