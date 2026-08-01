import { describe, expect, it } from 'vitest'
import {
  decidePortOccupiedAction,
  decideStalePidAction,
  matchesSidecarSignature,
  parseLsofListeningPids,
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
        'C:\\Blurt\\venv\\Scripts\\python.exe C:\\Blurt\\app\\resources\\serve_gpu.py serve --port 9379'
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
  // This is only ever called after a real trial bind (`isPortFree`) has
  // already found the port occupied - so an empty `foreignPids` list is NOT
  // evidence of "actually free", just "couldn't identify who's holding it"
  // (see `findPidsListeningOnPort`'s doc comment). Both branches must
  // therefore refuse to proceed; this used to incorrectly `proceed` on the
  // empty case, which on a platform where the lookup tool is missing or
  // fails silently defeated this module's entire purpose.
  it('errors with a less specific message when nothing foreign was identified (tool missing/unparsable, not an actually-free port)', () => {
    const result = decidePortOccupiedAction({ port: 9379, foreignPids: [] })
    expect(result.action).toBe('error')
    expect(result.action === 'error' && result.message).toMatch(/9379/)
    expect(result.action === 'error' && result.message).toMatch(/couldn't be identified/)
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

describe('parseLsofListeningPids', () => {
  // Realistic-looking `lsof -nP -iTCP:9379 -sTCP:LISTEN` capture: the same
  // pid shows up twice, once per IPv4/IPv6 socket, which is why dedup matters.
  const sample = [
    'COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME',
    'python3.1 54321 garrett   12u  IPv4 0x8f3a2b1c9d0e4f56      0t0  TCP 127.0.0.1:9379 (LISTEN)',
    'python3.1 54321 garrett   13u  IPv6 0x1a2b3c4d5e6f7890      0t0  TCP [::1]:9379 (LISTEN)'
  ].join('\n')

  it('extracts the PID of a LISTEN row bound to the target port', () => {
    expect(parseLsofListeningPids(sample, 9379)).toEqual([54321])
  })

  it('dedupes the same PID appearing on both its IPv4 and IPv6 listening sockets', () => {
    expect(parseLsofListeningPids(sample, 9379)).toHaveLength(1)
  })

  it('matches an IPv6-addressed LISTEN row on its own', () => {
    const ipv6Only =
      'python3.1 54321 garrett   13u  IPv6 0x1a2b3c4d5e6f7890      0t0  TCP [::1]:9379 (LISTEN)'
    expect(parseLsofListeningPids(ipv6Only, 9379)).toEqual([54321])
  })

  it('ignores LISTEN rows on other ports', () => {
    expect(parseLsofListeningPids(sample, 5173)).toEqual([])
  })

  it('skips the header row', () => {
    const headerOnly = 'COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME'
    expect(parseLsofListeningPids(headerOnly, 9379)).toEqual([])
  })

  it('ignores non-LISTEN rows (e.g. an already-established connection) even if the port matches', () => {
    const established =
      'python3.1 54321 garrett   14u  IPv4 0x1234abcd      0t0  TCP 127.0.0.1:9379->127.0.0.1:54444 (ESTABLISHED)'
    expect(parseLsofListeningPids(established, 9379)).toEqual([])
  })

  it('returns an empty array for garbage input rather than throwing', () => {
    const garbage = 'not lsof output\nrandom garbage line\n\t\n(LISTEN)\nfoo (LISTEN)'
    expect(() => parseLsofListeningPids(garbage, 9379)).not.toThrow()
    expect(parseLsofListeningPids(garbage, 9379)).toEqual([])
  })

  it('returns an empty array when nothing matches', () => {
    expect(parseLsofListeningPids(sample, 6666)).toEqual([])
  })
})
