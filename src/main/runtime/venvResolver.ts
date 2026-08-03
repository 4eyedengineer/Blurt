import { existsSync, readFileSync } from 'fs'
// `join` (host-native) only for reading a real file inside an already
// absolute venvDir. Path *construction* below deliberately uses the explicit
// posix/win32 variants instead - see venvPathsFor.
import { join, posix, win32 } from 'path'

/**
 * Everything pip-installed into the runtime venv, pinned, in the order they
 * are installed and recorded.
 *
 * `litert-lm` runs the language model. `onnx-asr` plus an ONNX Runtime build
 * run the speech recogniser (see resources/asr.py), and `numpy` carries the
 * audio between them. All are pure wheels, so none of this asks the user's
 * machine to compile anything - which was the main risk in adding a second
 * inference runtime at all.
 *
 * The ONNX Runtime build is platform-specific and cannot be otherwise:
 * `onnxruntime-directml` exists only for Windows, and it is what puts the
 * recogniser on the GPU there (any Direct3D 12 adapter, no CUDA dependency -
 * which would be NVIDIA-only and several hundred MB). macOS gets the stock
 * build, whose CoreML provider covers Apple Silicon. The two packages
 * conflict, so exactly one is installed.
 *
 * Every version is pinned to one verified working against a real Windows
 * host with a discrete NVIDIA GPU (see WINDOWS.md's GPU section). Bumped
 * deliberately when a newer one is verified, never automatically -
 * `--upgrade` without a pin would silently change behaviour on some future
 * relaunch.
 *
 * macOS is arm64 (Apple Silicon) only. Not a preference of this project's,
 * an upstream packaging constraint: per PyPI, `litert-lm` itself ships a
 * pure-Python wheel, but its engine dependency `litert-lm-api` publishes
 * macOS wheels tagged only `macosx_12_0_arm64` - true of every release from
 * 0.12.0 through 0.14.0, with no Intel/x86_64 or `universal2` build in any
 * of them. On an Intel Mac the install step fails outright with pip's own
 * "no matching distribution found". That is the correct outcome, not a bug
 * to route around: it surfaces through the same pip-failure text the setup
 * screen already shows for any other pip failure, rather than this code
 * detecting Intel Macs itself and pre-empting pip with a parallel error
 * path.
 */
export function runtimePipSpecs(platform: NodeJS.Platform = process.platform): string[] {
  const onnxRuntime = platform === 'win32' ? 'onnxruntime-directml==1.24.4' : 'onnxruntime==1.24.4'
  return ['litert-lm==0.14.0', onnxRuntime, 'onnx-asr==0.12.0', 'numpy>=2.0']
}

/** Written into the venv once every package in RUNTIME_PIP_SPECS installed cleanly - see isVenvHealthy for what it is for. */
export const RUNTIME_MARKER_FILENAME = '.blurt-runtime'

/**
 * Expected contents of RUNTIME_MARKER_FILENAME for this build. Compared
 * exactly, so the spec order is part of the contract - and so is the
 * platform, since a venv provisioned for one carries the wrong ONNX Runtime
 * for another.
 */
export function runtimeMarkerContents(platform: NodeJS.Platform = process.platform): string {
  return runtimePipSpecs(platform).join('\n')
}

/**
 * Resolves the location and health of the self-managed Python venv that
 * backs the packaged app's managed sidecar (`litert-lm serve` / the GPU
 * wrapper) - deterministically, with no PATH lookups.
 *
 * Deliberately independent of any dev-only venv a contributor might set up
 * for themselves (e.g. a repo-relative `.runtime/venv` on WSL/Linux): a
 * packaged app on the same Windows machine always resolves to this exact
 * `%LOCALAPPDATA%\Blurt\venv`, and on the same Mac always resolves to
 * `$HOME/Library/Application Support/Blurt/venv`, reusing it across
 * installs/relaunches rather than creating a second copy. Windows and macOS
 * are the two packaged, runtime-managed targets (see
 * `isRuntimeManagedPlatform`); the posix venv layout (`bin/python`,
 * `bin/litert-lm`) is genuinely used on macOS, and as a side effect also
 * keeps this module's pure logic unit-testable on plain Linux (CI, WSL dev
 * hosts) - which never provisions a managed venv of its own (see
 * `DEFAULT_MANAGED_COMMAND` in shared/types.ts) but still exercises this
 * same posix code path in tests.
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
 * test running on Linux CI. macOS takes the posix branch unchanged - same
 * `bin/python` / `bin/litert-lm` shape as Linux (see this file's darwin
 * test cases).
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
 * Whether this platform gets a self-managed Python venv at all - true only
 * for win32 and darwin, the two packaged, native-installer targets. Gates
 * whether the app provisions its own venv/interpreter in the first place
 * (see main/index.ts's `ensureRuntime`, which no-ops entirely when this is
 * false) - everything else in this file (`getRuntimeBaseDir`, and by
 * extension `runFirstRunSetup`) assumes this has already been checked, and
 * throws rather than silently doing the wrong thing if called anyway on an
 * unsupported platform.
 *
 * Linux/WSL is deliberately excluded, not merely "not implemented yet":
 * there's no platform-standard base directory to target the way
 * `%LOCALAPPDATA%` and `~/Library/Application Support` are on their
 * platforms, and a working alternative already exists for dev use there - a
 * hand-configured sidecar command pointed at a contributor-managed venv
 * (see `DEFAULT_MANAGED_COMMAND` in shared/types.ts).
 */
export function isRuntimeManagedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}

/**
 * The fixed, deterministic runtime base directory that backs the
 * self-managed venv - `%LOCALAPPDATA%\Blurt` on Windows,
 * `$HOME/Library/Application Support/Blurt` on macOS.
 *
 * Read directly from the environment (not `app.getPath(...)`), for two
 * different reasons per platform:
 * - Windows: Electron's `getPath` has no `'localAppData'` name at all -
 *   only `'appData'` (`%APPDATA%`, Roaming), a different directory
 *   entirely.
 * - macOS: `app.getPath('userData')` *does* happen to resolve to this same
 *   `~/Library/Application Support/Blurt` directory, but that's the app's
 *   general-purpose *data* directory - settings.json, dictation history,
 *   downloaded models (see the `app.getPath('userData')` call sites in
 *   main/index.ts). Deriving the venv location independently rather than
 *   reusing that path keeps this module decoupled from Electron (no
 *   `electron` import here) and identical in shape across platforms - both
 *   deliberate, pre-existing properties of this module that this function
 *   preserves rather than special-cases away now that there are two
 *   platforms.
 *
 * Throws if the platform's base-directory env var (`LOCALAPPDATA` / `HOME`)
 * isn't set, and throws for any platform that isn't win32/darwin at all - a
 * loud startup failure in both cases instead of silently resolving to a
 * wrong or relative path. Callers should check `isRuntimeManagedPlatform`
 * before calling this; this function does not check it for you.
 */
export function getRuntimeBaseDir(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): string {
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA
    if (!localAppData) {
      throw new Error(
        "LOCALAPPDATA environment variable is not set - can't resolve the runtime venv location. This is expected only on Windows; the packaged app requires it."
      )
    }
    return win32.join(localAppData, 'Blurt')
  }
  if (platform === 'darwin') {
    const home = env.HOME
    if (!home) {
      throw new Error(
        "HOME environment variable is not set - can't resolve the runtime venv location. This is expected only on macOS; the packaged app requires it."
      )
    }
    return posix.join(home, 'Library', 'Application Support', 'Blurt')
  }
  throw new Error(
    `Unsupported platform '${platform}' - the self-managed runtime venv is only implemented for win32 and darwin (see isRuntimeManagedPlatform).`
  )
}

/**
 * Whether this venv is usable as-is, or has to be provisioned again.
 *
 * The interpreter and the `litert-lm` script existing is necessary but not
 * sufficient. A venv built by an older Blurt has both and is still missing
 * whatever packages a newer Blurt added - `ai-edge-litert` and friends for
 * the speech recogniser, most recently. Judged on file existence alone, such
 * a venv passes, setup is skipped, and every dictation then fails on an
 * import error inside the sidecar, on exactly the machines that have been
 * running Blurt longest.
 *
 * So the marker written at the end of a successful install has to match the
 * dependency set this build expects, byte for byte. Anything else - absent,
 * stale, half-written - means provision again. That is cheap and safe (pip
 * skips what is already satisfied), and it makes future dependency changes
 * self-healing rather than a silent breakage nobody thinks to check for.
 */
export function isVenvHealthy(paths: VenvPaths): boolean {
  if (!existsSync(paths.pythonExe) || !existsSync(paths.litertLmExe)) return false
  try {
    const marker = readFileSync(join(paths.venvDir, RUNTIME_MARKER_FILENAME), 'utf-8')
    return marker.trim() === runtimeMarkerContents().trim()
  } catch {
    return false
  }
}
