import { describe, expect, it } from 'vitest'
import {
  isPythonVersionOk,
  NoPythonFoundError,
  noPythonFoundMessage,
  probePython,
  pythonCandidatesFor
} from './firstRunSetup'

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

  it('tries python3 before bare python on generic posix', () => {
    const candidates = pythonCandidatesFor('linux')
    expect(candidates[0].cmd).toBe('python3')
  })

  it('probes absolute paths before any bare name on darwin', () => {
    const candidates = pythonCandidatesFor('darwin')
    const firstBareIndex = candidates.findIndex((c) => !c.cmd.startsWith('/'))
    expect(firstBareIndex).toBeGreaterThan(0)
    for (const candidate of candidates.slice(0, firstBareIndex)) {
      expect(candidate.cmd.startsWith('/')).toBe(true)
    }
    // Everything from firstBareIndex onward must also be bare (no absolute
    // path candidate is ever ordered after a bare one).
    for (const candidate of candidates.slice(firstBareIndex)) {
      expect(candidate.cmd.startsWith('/')).toBe(false)
    }
  })

  it('prefers Homebrew (Apple Silicon prefix) over the python.org Framework install on darwin', () => {
    const candidates = pythonCandidatesFor('darwin')
    const homebrewIndex = candidates.findIndex((c) => c.cmd.startsWith('/opt/homebrew/'))
    const frameworkIndex = candidates.findIndex((c) => c.cmd.includes('Python.framework'))
    expect(homebrewIndex).toBe(0)
    expect(frameworkIndex).toBeGreaterThan(homebrewIndex)
  })

  it('prefers newer pinned minor versions before the unversioned symlink, per location, on darwin', () => {
    const candidates = pythonCandidatesFor('darwin')
    const cmds = candidates.map((c) => c.cmd)
    expect(cmds.indexOf('/opt/homebrew/bin/python3.12')).toBeLessThan(
      cmds.indexOf('/opt/homebrew/bin/python3.11')
    )
    expect(cmds.indexOf('/opt/homebrew/bin/python3.11')).toBeLessThan(
      cmds.indexOf('/opt/homebrew/bin/python3')
    )
    expect(
      cmds.indexOf('/Library/Frameworks/Python.framework/Versions/3.12/bin/python3')
    ).toBeLessThan(cmds.indexOf('/Library/Frameworks/Python.framework/Versions/3.11/bin/python3'))
  })

  it('never lists /usr/bin/python3 (the CLT stub hazard) as a candidate on darwin', () => {
    const candidates = pythonCandidatesFor('darwin')
    expect(candidates.some((c) => c.cmd === '/usr/bin/python3')).toBe(false)
  })

  it('ends with bare python3 then bare python on darwin, kept as a last resort', () => {
    const candidates = pythonCandidatesFor('darwin')
    expect(candidates[candidates.length - 2]).toEqual({ cmd: 'python3', args: [] })
    expect(candidates[candidates.length - 1]).toEqual({ cmd: 'python', args: [] })
  })
})

describe('probePython', () => {
  it('returns null for a nonexistent binary', () => {
    expect(probePython({ cmd: 'this-binary-does-not-exist-xyz', args: [] })).toBeNull()
  })

  it('returns null for a nonexistent absolute path (no shell/PATH involved)', () => {
    expect(
      probePython({ cmd: '/opt/homebrew/bin/this-definitely-does-not-exist-python', args: [] })
    ).toBeNull()
  })
})

describe('noPythonFoundMessage', () => {
  it('keeps the win32 copy byte-identical to the original, pre-extraction message', () => {
    expect(noPythonFoundMessage('win32')).toBe(
      'No Python 3.10+ installation was found. Install Python 3.10+ from python.org (check "Add python.exe to PATH"), then relaunch Blurt.'
    )
  })

  it('gives macOS-specific guidance mentioning Homebrew and the CLT stub', () => {
    const message = noPythonFoundMessage('darwin')
    expect(message).toMatch(/brew install python/)
    expect(message).toMatch(/Command Line Tools/)
    expect(message).not.toBe(noPythonFoundMessage('win32'))
  })

  it('falls back to the win32 copy for any platform other than darwin', () => {
    expect(noPythonFoundMessage('linux')).toBe(noPythonFoundMessage('win32'))
  })
})

describe('NoPythonFoundError', () => {
  it('carries the platform-specific message for the platform it is given', () => {
    expect(new NoPythonFoundError('darwin').message).toBe(noPythonFoundMessage('darwin'))
    expect(new NoPythonFoundError('win32').message).toBe(noPythonFoundMessage('win32'))
  })

  it('defaults to process.platform when constructed with no argument', () => {
    expect(new NoPythonFoundError().message).toBe(noPythonFoundMessage(process.platform))
  })

  it('sets its name for instanceof-independent identification', () => {
    expect(new NoPythonFoundError('darwin').name).toBe('NoPythonFoundError')
  })
})
