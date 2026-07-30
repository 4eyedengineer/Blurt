import { spawn, spawnSync } from 'child_process'
import type { VenvPaths } from './venvResolver'

/**
 * Orchestrates the packaged app's first-run bootstrap when no healthy venv
 * is found under `%LOCALAPPDATA%\WindowsEloquent\venv` (see
 * `venvResolver.ts`): find a Python 3.10+ interpreter, create the venv, pip
 * install the pinned `litert-lm` version into it. Mirrors
 * `Start-Eloquent.ps1`'s "Python 3.10+" / "Persistent venv + litert-lm"
 * steps, but deliberately does NOT auto-install Python via winget (or
 * anything else) the way the ps1 launcher does - the packaged app is meant
 * to be a normal, unsurprising Windows app; silently shelling out to winget
 * on first launch is not that. If no interpreter is found, this throws
 * `NoPythonFoundError` and the caller shows a hard error screen instead.
 */

/**
 * Pinned to the exact version verified working against a real Windows host
 * (RTX 3060 Laptop GPU) - see WINDOWS.md's GPU section. Bumped deliberately
 * when a newer version is verified, never automatically (`--upgrade`
 * without a pin would silently change behavior on some future relaunch).
 */
export const LITERT_LM_PINNED_VERSION = '0.14.0'

export interface PythonCandidate {
  cmd: string
  args: string[]
}

/**
 * Deterministic probe order - first hit wins, no "pick the newest" scoring.
 * Windows: the `py` launcher (ships with every python.org installer) is
 * tried before bare `python` specifically because a bare `python` on
 * Windows PATH is the least reliable of the three (can be the Microsoft
 * Store app-execution-alias stub, or absent entirely, even when `py` isn't)
 * - mirrors `Start-Eloquent.ps1`'s own preference order.
 */
export function pythonCandidatesFor(platform: NodeJS.Platform): PythonCandidate[] {
  if (platform === 'win32') {
    return [
      { cmd: 'py', args: ['-3.12'] },
      { cmd: 'py', args: ['-3'] },
      { cmd: 'python', args: [] }
    ]
  }
  // Only reachable in tests/dev on non-Windows - the packaged app itself is
  // Windows-only (see WINDOWS.md) - kept for testability of the pure logic.
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
 * Probes one candidate by actually invoking it - the only reliable way to
 * learn both its resolved absolute path (`sys.executable`, not just
 * whatever name/launcher was tried) and its version in one shot. Returns
 * null on any failure (not found, wrong version, non-zero exit, malformed
 * output) - the caller just moves on to the next candidate.
 */
export function probePython(candidate: PythonCandidate): FoundPython | null {
  try {
    const result = spawnSync(candidate.cmd, [...candidate.args, '-c', PROBE_SCRIPT], {
      encoding: 'utf-8',
      windowsHide: true
    })
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
export function findPython(platform: NodeJS.Platform = process.platform): FoundPython | null {
  for (const candidate of pythonCandidatesFor(platform)) {
    const found = probePython(candidate)
    if (found) return found
  }
  return null
}

/** Thrown by `runFirstRunSetup` when no Python 3.10+ interpreter can be found - its `.message` is the exact user-facing copy shown on the setup screen's hard-error state. */
export class NoPythonFoundError extends Error {
  constructor() {
    super(
      'No Python 3.10+ installation was found. Install Python 3.10+ from python.org (check "Add python.exe to PATH"), then relaunch Windows Eloquent.'
    )
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
  { id: 'litert-lm', label: `Installing litert-lm ${LITERT_LM_PINNED_VERSION}` }
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
 * per-step "already done" skip logic like `Start-Eloquent.ps1` has, since a
 * partially-set-up venv on a fresh packaged install would be unusual enough
 * to just start clean.
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
