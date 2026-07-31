/**
 * Pure policy: given a catalog entry's approximate download size and a
 * `HardwareProbeResult`, decide whether this machine can even attempt this
 * model, and what's worth telling the user. No Electron/DOM/Node imports -
 * this runs identically in the main process (to gate a download - see
 * ModelManager.download) and in the renderer (to show the same numbers on
 * the Settings screen before the user commits to a download).
 */
import type { ModelCatalogEntry } from './models'
import type { HardwareProbeResult } from './hardware'

const GIB = 1024 ** 3

/**
 * The model is stored TWICE on disk once installed - once as the raw
 * downloaded `.litertlm` under `models/`, and again as `litert-lm import`'s
 * copy under `litert-lm-home/models/<alias>/model.litertlm` (see
 * ModelManager's class doc comment) - plus ~1 GiB of xnnpack shader caches
 * that show up alongside the imported copy. Measured on a real host for
 * Gemma 4 E2B (approxSizeBytes 2_588_147_712): models/ = 2.5G, litert-lm-home/
 * = 3.5G, i.e. very close to 2x the download plus 1 GiB - not the ~2.4 GB
 * the UI used to advertise as the total cost.
 */
export function requiredDiskBytes(approxSizeBytes: number): number {
  return 2 * approxSizeBytes + GIB
}

/**
 * The weights have to be fully resident in RAM to run at all (even on CPU
 * once `resources/serve_gpu.py` falls back off GPU) - approxSizeBytes plus
 * 2 GiB of headroom for the OS, this app, and everything else running.
 */
export function requiredRamBytes(approxSizeBytes: number): number {
  return approxSizeBytes + 2 * GIB
}

export interface ModelRequirementsResult {
  /** Hard stops - the download/run should not proceed while any of these are non-empty. */
  blockers: string[]
  /** Non-blocking, e.g. "will run on CPU instead". */
  notes: string[]
}

function formatGiB(bytes: number): string {
  return `${(bytes / GIB).toFixed(1)} GB`
}

/**
 * Disk and RAM are hard blockers - the download can't produce a usable model
 * without both. VRAM is NEVER a blocker: `resources/serve_gpu.py` falls back
 * to CPU when the GPU can't or won't take the model, just slower, so
 * insufficient VRAM is only ever a note - and only when VRAM is actually
 * known; an undetermined GPU produces no VRAM-related message at all rather
 * than guessing.
 */
export function checkModelRequirements(
  entry: ModelCatalogEntry,
  hardware: HardwareProbeResult
): ModelRequirementsResult {
  const blockers: string[] = []
  const notes: string[] = []

  const neededDisk = requiredDiskBytes(entry.approxSizeBytes)
  if (hardware.freeDiskBytes !== null && hardware.freeDiskBytes < neededDisk) {
    blockers.push(
      `Needs about ${formatGiB(neededDisk)} free; this drive has ${formatGiB(hardware.freeDiskBytes)}.`
    )
  }

  const neededRam = requiredRamBytes(entry.approxSizeBytes)
  if (hardware.totalRamBytes < neededRam) {
    blockers.push(
      `Needs about ${formatGiB(neededRam)} RAM; this machine has ${formatGiB(hardware.totalRamBytes)}.`
    )
  }

  const knownVramBytes = hardware.gpus
    .map((gpu) => gpu.dedicatedVramBytes)
    .filter((bytes): bytes is number => bytes !== null)
  if (knownVramBytes.length > 0) {
    const largestVram = Math.max(...knownVramBytes)
    if (largestVram < entry.approxSizeBytes) {
      notes.push(`Not enough GPU VRAM - will run on CPU instead, slower.`)
    }
  }
  // No GPU VRAM could be determined at all (no GPU detected, or the probe
  // failed/timed out) - say nothing rather than guess either way.

  return { blockers, notes }
}
