import { existsSync } from 'fs'
import { join, posix, win32 } from 'path'

/**
 * Resolves the location and health of the self-managed Python venv that
 * backs the packaged app's managed sidecar (`litert-lm serve` / the GPU
 * wrapper) - deterministically, with no PATH lookups.
 *
 * Deliberately shared with the dev launchers: `Start-Eloquent.ps1` creates
 * this exact same `%LOCALAPPDATA%\WindowsEloquent\venv` on Windows (see its
 * "Persistent venv + litert-lm" step) - a packaged app on the same machine
 * reuses it rather than creating a second copy, and vice versa. The posix
 * venv layout (`bin/python`, `bin/litert-lm`) exists only so this module's
 * pure logic is testable on any host; the packaged app itself only ever
 * runs on Windows (see WINDOWS.md), where `run.sh`'s own `.runtime/venv`
 * (repo-relative, not `%LOCALAPPDATA%`) is a separate, WSL/Linux-only venv -
 * intentionally not shared with the Windows one.
 */

export interface VenvPaths {
  venvDir: string
  pythonExe: string
  litertLmExe: string
}

/**
 * Windows vs posix venv directory layout - `Scripts\` vs `bin/`, `.exe` vs
 * no suffix. Uses `path.win32`/`path.posix` explicitly (not the ambient
 * `join`, which follows the *host* OS regardless of `platform`) so this is
 * deterministic and unit-testable from any host, not just the one it's
 * meant to describe - e.g. asserting a backslash-joined Windows path from a
 * test running on Linux CI.
 */
export function venvPathsFor(venvDir: string, platform: NodeJS.Platform): VenvPaths {
  const join = platform === 'win32' ? win32.join : posix.join
  if (platform === 'win32') {
    return {
      venvDir,
      pythonExe: join(venvDir, 'Scripts', 'python.exe'),
      litertLmExe: join(venvDir, 'Scripts', 'litert-lm.exe')
    }
  }
  return {
    venvDir,
    pythonExe: join(venvDir, 'bin', 'python'),
    litertLmExe: join(venvDir, 'bin', 'litert-lm')
  }
}

/**
 * The fixed, deterministic runtime base directory - `%LOCALAPPDATA%\WindowsEloquent`.
 * Read directly from the environment (not `app.getPath(...)`) because
 * Electron's `getPath` has no `'localAppData'` name - only `'appData'`
 * (`%APPDATA%`, Roaming) - and this must match `Start-Eloquent.ps1`'s
 * `$env:LOCALAPPDATA\WindowsEloquent` exactly, not some other directory.
 * Throws if `LOCALAPPDATA` isn't set, which should never happen on a real
 * Windows session - better a loud, immediate startup error than silently
 * resolving to some wrong/relative path.
 */
export function getRuntimeBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const localAppData = env.LOCALAPPDATA
  if (!localAppData) {
    throw new Error(
      "LOCALAPPDATA environment variable is not set - can't resolve the runtime venv location. This is expected only on Windows; the packaged app requires it."
    )
  }
  return join(localAppData, 'WindowsEloquent')
}

/** Whether both the interpreter and the `litert-lm` console-script exist - the same check `Start-Eloquent.ps1` uses to decide whether to (re)create the venv. */
export function isVenvHealthy(paths: VenvPaths): boolean {
  return existsSync(paths.pythonExe) && existsSync(paths.litertLmExe)
}

/** Convenience: resolve the current platform's venv paths under the default runtime base dir. */
export function resolveDefaultVenvPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): VenvPaths {
  return venvPathsFor(join(getRuntimeBaseDir(env), 'venv'), platform)
}
