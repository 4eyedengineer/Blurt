/**
 * Shapes for the hardware facts `src/main/hardware/hardwareProbe.ts` gathers,
 * kept in shared/ (not main/) so `modelRequirements.ts` - a pure,
 * Electron-free policy function also used from the renderer for the
 * Settings screen - can depend on this shape without depending on main/.
 *
 * Every field that can't be determined on a given machine is `null`, never a
 * guessed number - see hardwareProbe.ts's doc comment for exactly which
 * cases produce `null` and why.
 */

export interface GpuInfo {
  /** Adapter display name, e.g. "NVIDIA GeForce RTX Laptop GPU" - from the registry's DriverDesc value. */
  name: string
  /**
   * Dedicated VRAM in bytes, from the registry's 64-bit
   * `HardwareInformation.qwMemorySize` value (NOT `Win32_VideoController.
   * AdapterRAM`, which is a uint32 that overflows on cards with >4 GiB VRAM -
   * measured on a 6 GB card: `AdapterRAM` reported ~4 GiB instead of the
   * correct 6 GiB). `null` means the adapter has no dedicated VRAM value at all (e.g. integrated
   * graphics) - not zero, and not "unknown, assume the worst".
   */
  dedicatedVramBytes: number | null
}

export interface HardwareProbeResult {
  /** Total system RAM in bytes, from os.totalmem(). Always known. */
  totalRamBytes: number
  /** Free space on the drive the model directory lives on, in bytes. `null` if it couldn't be determined (statfs failed). */
  freeDiskBytes: number | null
  /** Detected display adapters. Always `[]` on non-Windows (no probe attempted) or if the Windows probe failed/timed out - never a guess. */
  gpus: GpuInfo[]
}
