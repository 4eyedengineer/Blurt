import { describe, expect, it } from 'vitest'
import { isPythonVersionOk, probePython, pythonCandidatesFor } from './firstRunSetup'

describe('isPythonVersionOk', () => {
  it('accepts 3.10 and newer', () => {
    expect(isPythonVersionOk('3.10')).toBe(true)
    expect(isPythonVersionOk('3.12')).toBe(true)
    expect(isPythonVersionOk('3.13')).toBe(true)
  })

  it('rejects anything older than 3.10', () => {
    expect(isPythonVersionOk('3.9')).toBe(false)
    expect(isPythonVersionOk('3.8')).toBe(false)
    expect(isPythonVersionOk('2.7')).toBe(false)
  })

  it('rejects malformed strings', () => {
    expect(isPythonVersionOk('')).toBe(false)
    expect(isPythonVersionOk('three.ten')).toBe(false)
    expect(isPythonVersionOk('3')).toBe(false)
  })
})

describe('pythonCandidatesFor', () => {
  it('tries the py launcher before bare python on win32', () => {
    const candidates = pythonCandidatesFor('win32')
    expect(candidates[0]).toEqual({ cmd: 'py', args: ['-3.12'] })
    expect(candidates[candidates.length - 1]).toEqual({ cmd: 'python', args: [] })
  })

  it('tries python3 before bare python on posix', () => {
    const candidates = pythonCandidatesFor('linux')
    expect(candidates[0].cmd).toBe('python3')
  })
})

describe('probePython', () => {
  it('returns null for a nonexistent binary', () => {
    expect(probePython({ cmd: 'this-binary-does-not-exist-xyz', args: [] })).toBeNull()
  })
})
