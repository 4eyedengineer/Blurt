import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { parseGpuRegistryOutput, probeHardware } from './hardwareProbe'

describe('parseGpuRegistryOutput', () => {
  it('parses a discrete GPU line with a real qwMemorySize into bytes', () => {
    // Shape of a real captured line for a 6 GiB discrete card (adapter name
    // genericized here) - the whole reason this file exists:
    // Win32_VideoController.AdapterRAM overflows for a card like this
    // (reports ~4 GiB instead), but this registry value is correct.
    const gpus = parseGpuRegistryOutput('NVIDIA GeForce RTX Laptop GPU :: qwMemorySize=6442450944')
    expect(gpus).toEqual([
      { name: 'NVIDIA GeForce RTX Laptop GPU', dedicatedVramBytes: 6442450944 }
    ])
  })

  it('parses an integrated GPU with no qwMemorySize value as null, not zero', () => {
    // Real captured line - integrated graphics has no HardwareInformation.
    // qwMemorySize value at all, so the field after "=" is empty.
    const gpus = parseGpuRegistryOutput('Intel(R) UHD Graphics :: qwMemorySize=')
    expect(gpus).toEqual([{ name: 'Intel(R) UHD Graphics', dedicatedVramBytes: null }])
  })

  it('parses both real captured lines together, in order', () => {
    const output = [
      'Intel(R) UHD Graphics :: qwMemorySize=',
      'NVIDIA GeForce RTX Laptop GPU :: qwMemorySize=6442450944'
    ].join('\n')
    expect(parseGpuRegistryOutput(output)).toEqual([
      { name: 'Intel(R) UHD Graphics', dedicatedVramBytes: null },
      { name: 'NVIDIA GeForce RTX Laptop GPU', dedicatedVramBytes: 6442450944 }
    ])
  })

  it('handles CRLF line endings and blank lines between entries', () => {
    const output =
      '\r\nIntel(R) UHD Graphics :: qwMemorySize=\r\n\r\nNVIDIA GeForce RTX Laptop GPU :: qwMemorySize=6442450944\r\n'
    expect(parseGpuRegistryOutput(output)).toEqual([
      { name: 'Intel(R) UHD Graphics', dedicatedVramBytes: null },
      { name: 'NVIDIA GeForce RTX Laptop GPU', dedicatedVramBytes: 6442450944 }
    ])
  })

  it('returns [] for empty output', () => {
    expect(parseGpuRegistryOutput('')).toEqual([])
  })

  it('skips unrecognized lines instead of throwing (PowerShell noise, warnings, etc.)', () => {
    const output = [
      'WARNING: something unrelated printed to stdout',
      'NVIDIA GeForce RTX Laptop GPU :: qwMemorySize=6442450944',
      'not a matching line at all'
    ].join('\n')
    expect(parseGpuRegistryOutput(output)).toEqual([
      { name: 'NVIDIA GeForce RTX Laptop GPU', dedicatedVramBytes: 6442450944 }
    ])
  })

  /**
   * The exact stdout captured from a run that PowerShell exited 1 on, having
   * written nothing to stderr but CLIXML progress records. Both adapters are
   * present and correct, which is why the caller now parses stdout before
   * looking at the exit code rather than discarding it - see the `close`
   * handler in probeGpusWindows.
   */
  it('parses the output of a run that exited non-zero, since the adapters are still there', () => {
    const output =
      'Intel(R) UHD Graphics :: qwMemorySize=\r\n' +
      'NVIDIA GeForce RTX 3060 Laptop GPU :: qwMemorySize=6442450944\r\n'
    expect(parseGpuRegistryOutput(output)).toEqual([
      { name: 'Intel(R) UHD Graphics', dedicatedVramBytes: null },
      { name: 'NVIDIA GeForce RTX 3060 Laptop GPU', dedicatedVramBytes: 6442450944 }
    ])
  })

  /**
   * PowerShell serialises its progress stream as CLIXML when stderr is
   * redirected, and on the observed failing run that XML was the only thing
   * on stderr. If any of it ever reached stdout it must not be mistaken for
   * an adapter.
   */
  it('does not mistake CLIXML progress noise for an adapter line', () => {
    const output =
      '#< CLIXML\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04">' +
      '<Obj S="progress" RefId="0"><MS><AV>Preparing modules for first use.</AV></MS></Obj></Objs>'
    expect(parseGpuRegistryOutput(output)).toEqual([])
  })
})

describe('probeHardware', () => {
  it('reports totalRamBytes from the real host and never throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blurt-hw-probe-'))
    const result = await probeHardware(dir)
    expect(result.totalRamBytes).toBeGreaterThan(0)
  })

  it('resolves freeDiskBytes for a directory that exists', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'blurt-hw-probe-'))
    const result = await probeHardware(dir)
    expect(result.freeDiskBytes).not.toBeNull()
    expect(result.freeDiskBytes as number).toBeGreaterThan(0)
  })

  it('reports freeDiskBytes null (never a guessed number) for a directory that cannot be statfs-ed', async () => {
    const result = await probeHardware('/definitely/does/not/exist/blurt-hw-probe')
    expect(result.freeDiskBytes).toBeNull()
  })

  it('reports no GPUs on non-Windows platforms without attempting to spawn anything', async () => {
    // This suite only runs on non-Windows CI/dev hosts, so process.platform
    // is never 'win32' here - exercises the real early-return branch, not a
    // mock.
    expect(process.platform).not.toBe('win32')
    const dir = mkdtempSync(join(tmpdir(), 'blurt-hw-probe-'))
    const result = await probeHardware(dir)
    expect(result.gpus).toEqual([])
  })
})
