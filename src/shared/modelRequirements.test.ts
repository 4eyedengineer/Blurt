import { describe, expect, it } from 'vitest'
import { getCatalogEntry } from './models'
import { checkModelRequirements, requiredDiskBytes, requiredRamBytes } from './modelRequirements'
import type { HardwareProbeResult } from './hardware'

const GIB = 1024 ** 3

// Gemma 4 E2B's real approxSizeBytes from the catalog: 2_588_147_712.
const e2b = getCatalogEntry('gemma-4-e2b')

function hardware(overrides: Partial<HardwareProbeResult>): HardwareProbeResult {
  return {
    totalRamBytes: 32 * GIB,
    freeDiskBytes: 100 * GIB,
    gpus: [],
    ...overrides
  }
}

describe('requiredDiskBytes', () => {
  it('is 2x the download plus 1 GiB of caches - measured ratio for E2B', () => {
    expect(requiredDiskBytes(e2b.approxSizeBytes)).toBe(2 * e2b.approxSizeBytes + GIB)
  })
})

describe('requiredRamBytes', () => {
  it('is the download size plus 2 GiB headroom', () => {
    expect(requiredRamBytes(e2b.approxSizeBytes)).toBe(e2b.approxSizeBytes + 2 * GIB)
  })
})

describe('checkModelRequirements', () => {
  it('has no blockers or notes on a well-resourced machine with an ample GPU', () => {
    const result = checkModelRequirements(
      e2b,
      hardware({ gpus: [{ name: 'Example Discrete GPU', dedicatedVramBytes: 6 * GIB }] })
    )
    expect(result).toEqual({ blockers: [], notes: [] })
  })

  it('blocks when free disk space is known and below the 2x+1GiB requirement', () => {
    const result = checkModelRequirements(e2b, hardware({ freeDiskBytes: 3 * GIB }))
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0]).toMatch(/free/)
    expect(result.blockers[0]).toMatch(/3\.0 GB/)
  })

  it('does not block on disk when freeDiskBytes is unknown (null) - never guesses', () => {
    const result = checkModelRequirements(e2b, hardware({ freeDiskBytes: null }))
    expect(result.blockers).toEqual([])
  })

  it('blocks when total RAM is below approxSizeBytes + 2 GiB headroom', () => {
    const result = checkModelRequirements(e2b, hardware({ totalRamBytes: 3 * GIB }))
    expect(result.blockers).toHaveLength(1)
    expect(result.blockers[0]).toMatch(/RAM/)
  })

  it('can report both a disk and a RAM blocker at once', () => {
    const result = checkModelRequirements(
      e2b,
      hardware({ freeDiskBytes: 1 * GIB, totalRamBytes: 1 * GIB })
    )
    expect(result.blockers).toHaveLength(2)
  })

  it('never blocks on insufficient VRAM - only adds a note', () => {
    const result = checkModelRequirements(
      e2b,
      hardware({ gpus: [{ name: 'Integrated', dedicatedVramBytes: 512 * 1024 * 1024 }] })
    )
    expect(result.blockers).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toMatch(/CPU/)
  })

  it('picks the largest VRAM among multiple GPUs before deciding whether to note it', () => {
    const result = checkModelRequirements(
      e2b,
      hardware({
        gpus: [
          { name: 'Integrated', dedicatedVramBytes: null },
          { name: 'Discrete', dedicatedVramBytes: 8 * GIB }
        ]
      })
    )
    expect(result.notes).toEqual([])
  })

  it('says nothing about the GPU when no GPU was detected at all', () => {
    const result = checkModelRequirements(e2b, hardware({ gpus: [] }))
    expect(result.notes).toEqual([])
  })

  it('says nothing about the GPU when GPUs were found but VRAM could not be determined for any of them', () => {
    const result = checkModelRequirements(
      e2b,
      hardware({ gpus: [{ name: 'Some GPU', dedicatedVramBytes: null }] })
    )
    expect(result.notes).toEqual([])
  })
})
