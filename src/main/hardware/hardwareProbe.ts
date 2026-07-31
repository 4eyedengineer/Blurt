import { spawn } from 'child_process'
import { statfsSync } from 'fs'
import { totalmem } from 'os'
import type { GpuInfo, HardwareProbeResult } from '../../shared/hardware'
import { log } from '../log'

/**
 * How long to wait for the registry-reading PowerShell child before giving
 * up and reporting no GPUs. This runs on hardware/OS configurations we've
 * never seen, so it must never hang app startup (or a Settings screen
 * visit) waiting on a wedged or antivirus-throttled PowerShell.
 */
const GPU_PROBE_TIMEOUT_MS = 4000

/**
 * Enumerates every display-adapter subkey under this registry class and
 * prints one line per adapter that has a DriverDesc, in the form
 * "<name> :: qwMemorySize=<value-or-empty>" - deliberately plain
 * ("::"-delimited, one adapter per line) so `parseGpuRegistryOutput` can
 * stay a trivial regex rather than parsing structured PowerShell output
 * (CliXml/JSON) that could vary by PowerShell version.
 *
 * This is the registry key confirmed (by reading it on a real Windows host)
 * to hold a correct, 64-bit VRAM figure -
 * `Win32_VideoController.AdapterRAM` is a uint32 and silently overflows for
 * any card with more than ~4 GiB VRAM (measured: it reported 4293918720,
 * ~4 GiB, for an RTX 3060 that actually has 6 GiB).
 */
const GPU_REGISTRY_SCRIPT = `
$base = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'
Get-ChildItem -Path $base -ErrorAction SilentlyContinue | ForEach-Object {
  $item = Get-ItemProperty -Path $_.PSPath -ErrorAction SilentlyContinue
  if ($item -and $item.DriverDesc) {
    Write-Output "$($item.DriverDesc) :: qwMemorySize=$($item.'HardwareInformation.qwMemorySize')"
  }
}
`.trim()

/**
 * Parses captured stdout from GPU_REGISTRY_SCRIPT. Pure - no spawning - so
 * it's unit-testable against real captured lines without a Windows host or
 * a child process. An adapter with no qwMemorySize value (confirmed on a
 * real integrated GPU: "Intel(R) UHD Graphics :: qwMemorySize=", nothing
 * after the "=") parses to `dedicatedVramBytes: null`, not 0 - it has no
 * dedicated VRAM to report, which is a different fact than "has 0 bytes".
 * Any line that doesn't match the expected shape is silently skipped rather
 * than throwing - unrecognized PowerShell noise (a warning banner, a stray
 * blank line) must not blow up the whole probe.
 */
export function parseGpuRegistryOutput(output: string): GpuInfo[] {
  const gpus: GpuInfo[] = []
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = line.match(/^(.*?)\s*::\s*qwMemorySize=(\d*)\s*$/)
    if (!match) continue
    const name = match[1].trim()
    if (!name) continue
    const rawBytes = match[2]
    gpus.push({ name, dedicatedVramBytes: rawBytes ? Number(rawBytes) : null })
  }
  return gpus
}

/**
 * Runs GPU_REGISTRY_SCRIPT and parses its output. Never throws and never
 * hangs the caller: any spawn error, non-zero exit, or the GPU_PROBE_TIMEOUT_MS
 * timeout resolves to `[]` rather than rejecting or waiting indefinitely.
 * `windowsHide: true` because this is a console-subsystem child of our
 * GUI-subsystem process - without it Windows briefly steals foreground focus
 * for the console window (the exact bug fixed for paste injection in
 * paste.ts / model import in modelManager.ts; same fix applies here).
 */
function probeGpusWindows(): Promise<GpuInfo[]> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (gpus: GpuInfo[]): void => {
      if (settled) return
      settled = true
      resolve(gpus)
    }

    let child
    try {
      child = spawn(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', GPU_REGISTRY_SCRIPT],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      )
    } catch (err) {
      log.warn(
        `hardware: gpu probe spawn threw: ${err instanceof Error ? err.message : String(err)}`
      )
      finish([])
      return
    }

    const timer = setTimeout(() => {
      log.warn(`hardware: gpu probe timed out after ${GPU_PROBE_TIMEOUT_MS}ms, killing`)
      child.kill()
      finish([])
    }, GPU_PROBE_TIMEOUT_MS)

    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8')
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      log.warn(`hardware: gpu probe failed to run: ${err.message}`)
      finish([])
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        log.warn(`hardware: gpu probe exited with code ${code}`)
        finish([])
        return
      }
      finish(parseGpuRegistryOutput(stdout))
    })
  })
}

/**
 * Gathers hardware facts relevant to "can this machine run this model" -
 * asserts nothing itself (see modelRequirements.ts for the policy). Must
 * never throw: RAM is always known (os.totalmem() doesn't fail in
 * practice), but disk and GPU detection can both legitimately fail on
 * unknown hardware/OS configurations, and each failure degrades to `null`/
 * `[]` independently rather than aborting the whole probe.
 */
export async function probeHardware(modelsDir: string): Promise<HardwareProbeResult> {
  const totalRamBytes = totalmem()

  let freeDiskBytes: number | null = null
  try {
    const stats = statfsSync(modelsDir)
    freeDiskBytes = stats.bavail * stats.bsize
  } catch (err) {
    log.warn(
      `hardware: statfs failed for ${modelsDir}: ${err instanceof Error ? err.message : String(err)}`
    )
  }

  const gpus = process.platform === 'win32' ? await probeGpusWindows() : []

  log.info(
    `hardware: totalRam=${totalRamBytes} freeDisk=${freeDiskBytes ?? 'unknown'} gpus=${JSON.stringify(gpus)}`
  )

  return { totalRamBytes, freeDiskBytes, gpus }
}
