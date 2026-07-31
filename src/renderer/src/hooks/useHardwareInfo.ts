import { useEffect, useState } from 'react'
import type { HardwareProbeResult } from '@shared/hardware'

/**
 * Fetches this machine's RAM/disk/GPU facts once per Settings screen visit -
 * re-probed on mount (not cached across visits) since free disk space can
 * change between visits. `null` while loading; the Settings screen treats
 * that the same as "no blockers/notes yet" rather than blocking the UI on
 * it, since the GPU probe alone can take a few seconds on Windows (see
 * hardwareProbe.ts).
 */
export function useHardwareInfo(): HardwareProbeResult | null {
  const [hardware, setHardware] = useState<HardwareProbeResult | null>(null)

  useEffect(() => {
    let cancelled = false
    window.api.models.getHardware().then((result) => {
      if (!cancelled) setHardware(result)
    })
    return () => {
      cancelled = true
    }
  }, [])

  return hardware
}
