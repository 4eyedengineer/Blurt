import { describe, expect, it } from 'vitest'
import {
  decidePortOccupiedAction,
  decideStalePidAction,
  matchesSidecarSignature,
  parseNetstatListeningPids,
  parsePidFileContent,
  parseSsListeningPids,
  serializePidRecord
} from './portGuard'

describe('parsePidFileContent', () => {
  it('parses a well-formed record', () => {
    expect(
      parsePidFileContent('{"pid":1234,"port":9379,"startedAt":"2026-07-30T10:00:00.000Z"}')
    ).toEqual({ pid: 1234, port: 9379, startedAt: '2026-07-30T10:00:00.000Z' })
  })

  it('round-trips through serializePidRecord', () => {
    const record = { pid: 42, port: 9379, startedAt: '2026-01-01T00:00:00.000Z' }
    expect(parsePidFileContent(serializePidRecord(record))).toEqual(record)
  })

  it('returns null for invalid JSON', () => {
    expect(parsePidFileContent('not json')).toBeNull()
  })

  it('returns null for missing fields', () => {
    expect(parsePidFileContent('{"pid":1234}')).toBeNull()
  })

  it('returns null for wrong field types', () => {
    expect(parsePidFileContent('{"pid":"1234","port":9379,"startedAt":"x"}')).toBeNull()
  })

  it('returns null for non-positive pid/port', () => {
    expect(parsePidFileContent('{"pid":0,"port":9379,"startedAt":"x"}')).toBeNull()
    expect(parsePidFileContent('{"pid":123,"port":-1,"startedAt":"x"}')).toBeNull()
  })

  it('returns null for a JSON array or primitive', () => {
    expect(parsePidFileContent('[]')).toBeNull()
    expect(parsePidFileContent('42')).toBeNull()
  })
})

describe('matchesSidecarSignature', () => {
  it('matches the GPU wrapper', () => {
    expect(
      matchesSidecarSignature(
        'C:\\WindowsEloquent\\venv\\Scripts\\python.exe C:\\WindowsEloquent\\app\\resources\\serve_gpu.py serve --port 9379'
      )
    ).toBe(true)
  })

  it('matches a plain litert-lm serve invocation', () => {
    expect(matchesSidecarSignature('litert-lm serve --host 127.0.0.1 --port 9379')).toBe(true)
    expect(matchesSidecarSignature('/venv/bin/litert-lm serve --port 9379')).toBe(true)
  })

  it('does not match litert-lm used for something other than serve', () => {
    expect(matchesSidecarSignature('litert-lm import file.litertlm e2b')).toBe(false)
  })

  it('does not match an unrelated process', () => {
    expect(matchesSidecarSignature('C:\\Windows\\System32\\notepad.exe')).toBe(false)
    expect(matchesSidecarSignature('node server.js --port 9379 --serve')).toBe(false)
  })
})

describe('decideStalePidAction', () => {
  const record = { pid: 100, port: 9379, startedAt: '2026-07-30T10:00:00.000Z' }

  it('ignores when there is no record at all', () => {
    expect(decideStalePidAction({ record: null, isAlive: false, cmdline: null })).toEqual({
      action: 'ignore',
      reason: 'no sidecar pid file recorded'
    })
  })

  it('ignores when the recorded pid is no longer alive', () => {
    const result = decideStalePidAction({ record, isAlive: false, cmdline: null })
    expect(result.action).toBe('ignore')
    expect(result.reason).toMatch(/no longer alive/)
  })

  it('ignores (rather than guesses) when the cmdline could not be read', () => {
    const result = decideStalePidAction({ record, isAlive: true, cmdline: null })
    expect(result.action).toBe('ignore')
    expect(result.reason).toMatch(/couldn't be read/)
  })

  it('ignores when alive but cmdline does not match our signature (likely PID reuse)', () => {
    const result = decideStalePidAction({ record, isAlive: true, cmdline: 'notepad.exe' })
    expect(result.action).toBe('ignore')
    expect(result.reason).toMatch(/PID reuse/)
  })

  it('kills when alive and cmdline matches our sidecar signature', () => {
    const result = decideStalePidAction({
      record,
      isAlive: true,
      cmdline: 'python serve_gpu.py serve --port 9379'
    })
    expect(result.action).toBe('kill')
    expect(result.reason).toMatch(/pid 100/)
  })
})

describe('decidePortOccupiedAction', () => {
  it('proceeds when nothing foreign is listening', () => {
    expect(decidePortOccupiedAction({ port: 9379, foreignPids: [] })).toEqual({ action: 'proceed' })
  })

  it('errors, naming the PID(s), when a foreign process still holds the port', () => {
    const result = decidePortOccupiedAction({ port: 9379, foreignPids: [33740] })
    expect(result.action).toBe('error')
    expect(result.action === 'error' && result.message).toMatch(/9379/)
    expect(result.action === 'error' && result.message).toMatch(/33740/)
  })

  it('names all PIDs when more than one process is listening', () => {
    const result = decidePortOccupiedAction({ port: 9379, foreignPids: [111, 222] })
    expect(result.action === 'error' && result.message).toMatch(/111, 222/)
  })
})

describe('parseNetstatListeningPids', () => {
  const sample = [
    '',
    'Active Connections',
    '',
    '  Proto  Local Address          Foreign Address        State           PID',
    '  TCP    127.0.0.1:9379         0.0.0.0:0              LISTENING       33740',
    '  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       1234',
    '  TCP    127.0.0.1:54321        127.0.0.1:9379         ESTABLISHED     5555',
    ''
  ].join('\r\n')

  it('extracts the PID of a LISTENING socket bound to the target port', () => {
    expect(parseNetstatListeningPids(sample, 9379)).toEqual([33740])
  })

  it('ignores non-LISTENING lines mentioning the port (e.g. as the foreign address of a different connection)', () => {
    expect(parseNetstatListeningPids(sample, 9379)).not.toContain(5555)
  })

  it('ignores LISTENING sockets on other ports', () => {
    expect(parseNetstatListeningPids(sample, 5173)).toEqual([1234])
  })

  it('returns an empty array when nothing matches', () => {
    expect(parseNetstatListeningPids(sample, 6666)).toEqual([])
  })

  it('dedupes repeated PIDs', () => {
    const dup = [
      '  TCP    127.0.0.1:9379         0.0.0.0:0              LISTENING       33740',
      '  TCP    [::1]:9379             [::]:0                 LISTENING       33740'
    ].join('\r\n')
    expect(parseNetstatListeningPids(dup, 9379)).toEqual([33740])
  })
})

describe('parseSsListeningPids', () => {
  const sample = [
    'State     Recv-Q  Send-Q   Local Address:Port    Peer Address:Port   Process',
    'LISTEN    0       5        127.0.0.1:9379         0.0.0.0:*          users:(("litert-lm",pid=160299,fd=9))',
    'LISTEN    0       511      127.0.0.1:5173         0.0.0.0:*          users:(("node",pid=155196,fd=23))'
  ].join('\n')

  it('extracts the PID of a LISTEN socket bound to the target port', () => {
    expect(parseSsListeningPids(sample, 9379)).toEqual([160299])
  })

  it('ignores LISTEN sockets on other ports', () => {
    expect(parseSsListeningPids(sample, 5173)).toEqual([155196])
  })

  it('returns an empty array when nothing matches', () => {
    expect(parseSsListeningPids(sample, 6666)).toEqual([])
  })
})
