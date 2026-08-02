import { spawn, spawnSync } from 'child_process'
import type { VenvPaths } from './venvResolver'
import { log } from '../log'

/**
 * Orchestrates the packaged app's first-run bootstrap when no healthy venv
 * is found under the runtime base dir (`%LOCALAPPDATA%\Blurt` on Windows,
 * `$HOME/Library/Application Support/Blurt` on macOS - see
 * `venvResolver.ts`'s `getRuntimeBaseDir`/`isRuntimeManagedPlatform`): find a
 * Python 3.10+ interpreter, create the venv, pip install the pinned
 * `litert-lm` version into it. Deliberately does NOT auto-install Python via
 * winget, Homebrew, or anything else - the packaged app is meant to be a
 * normal, unsurprising native app on each platform; silently shelling out to
 * a package manager on first launch is not that. If no interpreter is
 * found, this throws `NoPythonFoundError` and the caller shows a hard error
 * screen instead.
 */

/**
 * Pinned to the exact version verified working against a real Windows host
 * (with a discrete NVIDIA GPU) - see WINDOWS.md's GPU section. Bumped deliberately
 * when a newer version is verified, never automatically (`--upgrade`
 * without a pin would silently change behavior on some future relaunch).
 *
 * macOS is arm64 (Apple Silicon) only - not a preference of this project's,
 * an upstream packaging constraint. Per PyPI, `litert-lm` itself ships a
 * pure-Python wheel (platform-independent), but its engine dependency
 * `litert-lm-api` publishes macOS wheels tagged only `macosx_12_0_arm64` -
 * true of every released version from 0.12.0 through 0.14.0, with no
 * Intel/x86_64 build and no `universal2` build in any of them. Concretely:
 * on an Intel Mac, step 3 below (`pip install litert-lm==<version>`) fails
 * outright with pip's own "no matching distribution found" error. That is
 * the correct, intended outcome, not a bug to route around - it surfaces
 * through the same pip-failure text this setup screen already shows for any
 * other pip failure (see `streamSpawn`/`runFirstRunSetup`), rather than this
 * code trying to detect Intel Macs itself and pre-empting pip with a
 * separate, parallel error path.
 */
const LITERT_LM_PINNED_VERSION = '0.14.0'

export interface PythonCandidate {
  cmd: string
  args: string[]
}

/**
 * Deterministic probe order - first hit wins, no "pick the newest" scoring.
 *
 * Windows: the `py` launcher (ships with every python.org installer) is
 * tried before bare `python` specifically because a bare `python` on
 * Windows PATH is the least reliable of the three (can be the Microsoft
 * Store app-execution-alias stub, or absent entirely, even when `py` isn't).
 *
 * macOS: absolute paths to real interpreters are probed before any bare
 * name - the opposite emphasis from Windows, and deliberate. A bare
 * `python3`/`python` is still resolved via a PATH lookup (`spawnSync` with
 * no shell still does an `execvp`-style PATH search for a command with no
 * `/` in it), and on a Mac with no Homebrew or python.org Python installed,
 * PATH very often still resolves `python3` to `/usr/bin/python3` - the
 * Xcode Command Line Tools' stub binary, not a real interpreter. Invoking
 * that stub when CLT isn't installed does not fail cleanly the way a
 * missing binary normally would: it pops a blocking system dialog ("The
 * "python3" command requires the command line developer tools...") and
 * only then returns non-zero, which would surface as a confusing GUI
 * interruption in the middle of what's supposed to be a quiet background
 * probe loop. Checking well-known absolute install locations first means
 * the common case (Homebrew or python.org actually installed) never
 * reaches that bare-name fallback at all, and so never risks the dialog.
 *
 * Order within the absolute-path candidates: Homebrew
 * (`/opt/homebrew/bin/...` - the Apple Silicon prefix; we ship arm64-only,
 * so Intel Homebrew's `/usr/local` is irrelevant here) before the
 * python.org Framework install path, and within each, the newest
 * known-good pinned minor version (3.12) before the previous one (3.11)
 * before that location's unversioned `python3` symlink - mirroring
 * Windows's "prefer the newest known-good, fall back gracefully" shape. The
 * trailing bare `python3`/`python` stays as a genuine last resort (not
 * removed entirely) for interpreters this has no well-known absolute path
 * for - pyenv shims, conda envs, etc. - accepting the CLT-stub hazard only
 * once every specific known location has already come up empty.
 *
 * `/usr/bin/python3` itself is deliberately never listed as a candidate:
 * unlike the paths above, it is exactly the ambiguous path that can be
 * either the CLT stub or (if CLT is installed) a real but too-old
 * interpreter - Apple's CLT-bundled Python has never shipped 3.10+ - so
 * listing it explicitly would buy nothing over the existing bare-name
 * fallback while suggesting it's a location worth trusting.
 */
export function pythonCandidatesFor(platform: NodeJS.Platform): PythonCandidate[] {
  if (platform === 'win32') {
    return [
      { cmd: 'py', args: ['-3.12'] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'python', args: [] }
    ]
  }
  if (platform === 'darwin') {
    return [
      { cmd: '/opt/homebrew/bin/python3.12', args: [] },
      { cmd: '/opt/homebrew/bin/python3.11', args: [] },
      { cmd: '/opt/homebrew/bin/python3', args: [] },
      { cmd: '/Library/Frameworks/Python.framework/Versions/3.12/bin/python3', args: [] },
      { cmd: '/Library/Frameworks/Python.framework/Versions/3.11/bin/python3', args: [] },
      { cmd: 'python3', args: [] },
      { cmd: 'python', args: [] }
    ]
  }
  // Generic posix fallback. Real dev use on Linux/WSL never reaches this via
  // the packaged app - `isRuntimeManagedPlatform` in venvResolver.ts (win32
  // and darwin only) excludes it from the managed-venv flow entirely, in
  // favor of a hand-configured sidecar command (see `DEFAULT_MANAGED_COMMAND`
  // in shared/types.ts). Kept so this pure logic stays unit-testable on a
  // plain Linux host/CI.
  return [
    { cmd: 'python3', args: [] },
    { cmd: 'python', args: [] }
  ]
}

const PROBE_SCRIPT = 'import sys; print(sys.executable); print("%d.%d" % sys.version_info[:2])'

export interface FoundPython {
  exe: string
  version: string
}

/** True for "3.10", "3.11", "3.12", ... - false for anything older or a malformed version string. */
export function isPythonVersionOk(version: string): boolean {
  const match = version.match(/^(\d+)\.(\d+)$/)
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major === 3 && minor >= 10
}

/**
 * How long a single interpreter probe may take before it is killed and
 * treated as "not a usable Python".
 *
 * This is a real hazard, not a theoretical one, and it is why the timeout
 * exists at all: `spawnSync` blocks the Electron main process outright, and
 * this runs during startup, before any window exists. macOS's
 * `/usr/bin/python3` is an Xcode Command Line Tools stub - invoking it
 * without the tools installed does not fail cleanly, it asks the OS to put
 * up a "install the command line developer tools?" dialog. A bare `python3`
 * is the last-resort darwin candidate (see `pythonCandidatesFor`) and PATH
 * can absolutely resolve it to that stub, so without a bound here a machine
 * in that state could hang Blurt's startup on a modal dialog it never
 * opened, with nothing on screen and nothing in main.log to explain it.
 *
 * Same reasoning - and the same resolution - as `GPU_PROBE_TIMEOUT_MS` in
 * hardware/hardwareProbe.ts: this code runs on OS configurations nobody
 * here has seen, so it must never be able to hang app startup. 5s is far
 * more than a real interpreter needs to print two lines and exit.
 */
const PYTHON_PROBE_TIMEOUT_MS = 5000

/**
 * Probes one candidate by actually invoking it - the only reliable way to
 * learn both its resolved absolute path (`sys.executable`, not just
 * whatever name/launcher was tried) and its version in one shot. Returns
 * null on any failure (not found, wrong version, non-zero exit, malformed
 * output, or `PYTHON_PROBE_TIMEOUT_MS` elapsing) - the caller just moves on
 * to the next candidate.
 */
export function probePython(candidate: PythonCandidate): FoundPython | null {
  try {
    const result = spawnSync(candidate.cmd, [...candidate.args, '-c', PROBE_SCRIPT], {
      encoding: 'utf-8',
      windowsHide: true,
      timeout: PYTHON_PROBE_TIMEOUT_MS
    })
    // A killed-on-timeout probe is reported via `error.code === 'ETIMEDOUT'`.
    // It is logged rather than folded into the generic `return null` below,
    // because "this interpreter hung" and "this interpreter isn't installed"
    // are very different problems for whoever reads main.log after a user
    // reports a slow or stuck first launch.
    if ((result.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') {
      log.warn(
        `runtime: python probe "${candidate.cmd}" timed out after ${PYTHON_PROBE_TIMEOUT_MS}ms and was killed - treating as unusable`
      )
      return null
    }
    if (result.error || result.status !== 0 || !result.stdout) return null
    const lines = result.stdout.trim().split(/\r?\n/)
    const exe = lines[0]?.trim()
    const version = lines[1]?.trim()
    if (!exe || !version || !isPythonVersionOk(version)) return null
    return { exe, version }
  } catch {
    return null
  }
}

/** Tries each candidate in order (see `pythonCandidatesFor`); returns the first Python 3.10+ found, or null if none qualify. */
function findPython(platform: NodeJS.Platform = process.platform): FoundPython | null {
  for (const candidate of pythonCandidatesFor(platform)) {
    const found = probePython(candidate)
    if (found) return found
  }
  return null
}

/**
 * User-facing copy for `NoPythonFoundError`, shown verbatim on the setup
 * screen's hard-error state (see `runtime/setupWindow.ts`'s
 * `showFatalError`) - kept short, concrete, and actionable, since it's the
 * only thing a stuck user sees.
 *
 * win32's string is byte-identical to the message this codebase used before
 * this function existed - it's only been extracted out of the error class
 * so it's independently testable and so a second platform can get its own
 * copy instead of one Windows-flavored string for everyone.
 *
 * darwin's string steers towards Homebrew/python.org rather than a generic
 * "go install Python", and calls out the Command Line Tools stub by name
 * (see `pythonCandidatesFor`'s doc comment for the mechanics): a user who
 * reacts to this message by running `python3 --version` in Terminal to
 * "check" gets the CLT-install dialog instead of a version string, and
 * installing CLT from that dialog would still leave them stuck (its bundled
 * Python, where present, is well below 3.10) without this saying so
 * explicitly.
 *
 * Every platform other than darwin gets the win32 copy. Not because it's
 * accurate there - "python.exe" plainly isn't - but because
 * `isRuntimeManagedPlatform` (venvResolver.ts) means the packaged app only
 * ever calls this with win32 or darwin in practice; a third bucket of copy
 * to maintain for a platform this feature doesn't run on isn't worth it.
 */
export function noPythonFoundMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return (
      'No Python 3.10+ installation was found. Install it with Homebrew ' +
      '("brew install python@3.12") or a python.org installer for macOS, then ' +
      "relaunch Blurt. (macOS's built-in /usr/bin/python3 is just an Xcode " +
      'Command Line Tools stub, not a full interpreter, so it does not count.)'
    )
  }
  return 'No Python 3.10+ installation was found. Install Python 3.10+ from python.org (check "Add python.exe to PATH"), then relaunch Blurt.'
}

/** Thrown by `runFirstRunSetup` when no Python 3.10+ interpreter can be found - its `.message` is the exact user-facing copy shown on the setup screen's hard-error state (see `noPythonFoundMessage`). */
export class NoPythonFoundError extends Error {
  constructor(platform: NodeJS.Platform = process.platform) {
    super(noPythonFoundMessage(platform))
    this.name = 'NoPythonFoundError'
  }
}

export type SetupLogFn = (line: string) => void

/** Spawns `cmd args`, streaming complete stdout/stderr lines to `onLine` as they arrive (buffered across chunk boundaries, same approach as `sidecar.ts`'s `handleStdout`), resolving on a zero exit code and rejecting otherwise. */
function streamSpawn(cmd: string, args: string[], onLine: SetupLogFn): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let tail = ''
    const handleChunk = (chunk: Buffer): void => {
      const combined = tail + chunk.toString('utf-8')
      const lines = combined.split('\n')
      tail = lines.pop() ?? ''
      for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '')
        if (line.trim().length > 0) onLine(line)
      }
    }
    child.stdout?.on('data', handleChunk)
    child.stderr?.on('data', handleChunk)
    child.on('error', (err) => reject(err))
    child.on('close', (code) => {
      if (tail.trim().length > 0) onLine(tail)
      if (code === 0) resolve()
      else reject(new Error(`'${cmd} ${args.join(' ')}' exited with code ${code}`))
    })
  })
}

export interface SetupStepDef {
  id: 'python' | 'venv' | 'litert-lm'
  label: string
}

/** Ordered step list surfaced on the setup screen - see main/index.ts's wiring and the setup window's step-list UI. */
export const SETUP_STEPS: SetupStepDef[] = [
  { id: 'python', label: 'Finding Python 3.10+' },
  { id: 'venv', label: 'Creating virtual environment' },
  { id: 'litert-lm', label: 'Installing speech engine' }
]

export interface FirstRunSetupCallbacks {
  onStepStart: (stepId: SetupStepDef['id']) => void
  onStepDone: (stepId: SetupStepDef['id']) => void
  onLine: SetupLogFn
}

/**
 * Runs the full first-run bootstrap in order: find Python, create the venv,
 * pip-install the pinned litert-lm. Only called when `isVenvHealthy(venv)`
 * is already false (see main/index.ts) - always runs every step, no
 * per-step "already done" skip logic, since a partially-set-up venv on a
 * fresh packaged install would be unusual enough to just start clean.
 */
export async function runFirstRunSetup(
  venv: VenvPaths,
  callbacks: FirstRunSetupCallbacks
): Promise<FoundPython> {
  callbacks.onStepStart('python')
  const python = findPython()
  if (!python) throw new NoPythonFoundError()
  callbacks.onLine(`Using ${python.exe} (Python ${python.version})`)
  callbacks.onStepDone('python')

  callbacks.onStepStart('venv')
  callbacks.onLine(`Creating virtual environment at ${venv.venvDir}`)
  await streamSpawn(python.exe, ['-m', 'venv', venv.venvDir], callbacks.onLine)
  callbacks.onStepDone('venv')

  callbacks.onStepStart('litert-lm')
  callbacks.onLine('Upgrading pip...')
  await streamSpawn(
    venv.pythonExe,
    ['-m', 'pip', 'install', '--quiet', '--upgrade', 'pip'],
    callbacks.onLine
  )
  callbacks.onLine(`Installing litert-lm==${LITERT_LM_PINNED_VERSION}...`)
  await streamSpawn(
    venv.pythonExe,
    ['-m', 'pip', 'install', '--quiet', `litert-lm==${LITERT_LM_PINNED_VERSION}`],
    callbacks.onLine
  )
  callbacks.onStepDone('litert-lm')

  return python
}
