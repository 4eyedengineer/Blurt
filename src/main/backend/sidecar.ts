import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'
import type { Accelerator } from '../../shared/types'
import { log } from '../log'
import { reclaimPortForSpawn, removePidFile, writePidFile } from './portGuard'

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'error'

/**
 * Matches `serve_gpu.py`'s `ELOQUENT_EFFECTIVE_BACKEND=gpu`/`=cpu` stdout
 * marker line (see that file's "Effective-backend reporting" doc comment).
 * Exported so it can be unit-tested without spawning a real process.
 */
const EFFECTIVE_BACKEND_LINE = /^ELOQUENT_EFFECTIVE_BACKEND=(cpu|gpu)\s*$/

/** Returns the accelerator reported by one line of a managed sidecar's stdout, or null if the line isn't the marker. */
export function parseEffectiveBackendLine(line: string): Accelerator | null {
  const match = line.match(EFFECTIVE_BACKEND_LINE)
  return match ? (match[1] as Accelerator) : null
}

export interface SidecarOptions {
  mode: 'managed' | 'external'
  /** Base URL to use directly when mode === 'external'. */
  externalUrl: string
  /** Command template for mode === 'managed', see SidecarSettings.managedCommand. */
  managedCommand: string
  /** Absolute path to the .litertlm model file, substituted into `{modelPath}`. */
  modelPath: string
  port: number
  /** Absolute path to `resources/serve_gpu.py`, substituted into `{wrapperPath}` - see `Accelerator`'s doc comment in shared/types.ts. Harmless to pass even when the template doesn't reference it. */
  wrapperPath?: string
  /** Extra environment variables merged over `process.env` for the spawned process (e.g. `LITERT_LM_DIR`, see ModelManager). Managed mode only. */
  env?: Record<string, string>
  /** Overridable for tests; defaults below. */
  readyTimeoutMs?: number
  readyPollIntervalMs?: number
  /**
   * Absolute path to a small JSON file (`userData/sidecar.pid`) used to
   * detect + reclaim a stale managed sidecar left running by a previous,
   * uncleanly-exited instance of this app before spawning a new one on the
   * same port - see `portGuard.ts`'s doc comment for the bug this fixes.
   * Managed mode only; omitted entirely (e.g. in tests), the hygiene step
   * is simply skipped.
   */
  pidFilePath?: string
}

/** Outcome of `resolveImportCli` - see its doc comment. */
export type ImportCliResolution = { ok: true; cli: string } | { ok: false; error: string }

/** Matches `litert-lm`/`litert-lm.exe` by name only (any path prefix). */
const LITERT_LM_CLI_NAME = /^litert-lm(\.exe)?$/i
/** Matches a Python interpreter by name only: `python`, `python3`, `python3.11`, `python.exe`, `python3.exe`, ... */
const PYTHON_INTERPRETER_NAME = /^python(?:\d+(?:\.\d+)?)?(\.exe)?$/i

/** The path-separator-agnostic last component of a path (works for both `/` and `\`-separated paths, regardless of host OS). */
function baseName(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  const idx = normalized.lastIndexOf('/')
  return idx === -1 ? path : path.slice(idx + 1)
}

/** Whether `path` looks like a Windows-style path (backslashes, a drive letter, or a `.exe` suffix) as opposed to a posix one - used only to decide which sibling-CLI convention (`Scripts\...exe` vs `bin/...`) to apply, never to decide *whether* to resolve at all. */
function looksWindowsStyle(path: string): boolean {
  return path.includes('\\') || /^[A-Za-z]:/.test(path) || path.toLowerCase().endsWith('.exe')
}

/**
 * Whether a *rendered* managed command's argv references the
 * `serve_gpu.py` wrapper - the deterministic rule (see `waitUntilReady`)
 * for whether the `ELOQUENT_EFFECTIVE_BACKEND` marker is required before
 * reporting ready. A plain `litert-lm serve` (the 'cpu' accelerator's
 * default template) never prints that marker, so requiring it there would
 * mean *never* becoming ready - checked against the actual argv the child
 * is about to be spawned with, not the accelerator setting, so a custom
 * managed command is handled correctly either way.
 */
export function commandReferencesServeGpuWrapper(args: string[]): boolean {
  return args.some((arg) => baseName(arg).toLowerCase() === 'serve_gpu.py')
}

/**
 * Resolves the `litert-lm` CLI to run the `import` step with, from a managed
 * sidecar command *template* (`SidecarSettings.managedCommand`) - NOT
 * necessarily the same binary used to `serve`. The two can differ: the GPU
 * accelerator's default template is `python "{wrapperPath}" serve ...` (see
 * `MANAGED_COMMAND_BY_ACCELERATOR` in shared/types.ts), whose first token is
 * a *Python interpreter*, not `litert-lm` - naively using it for `import`
 * produces `python import <file> <alias>`, which is nonsense (this was a
 * real bug: it spawned the system Python instead of `litert-lm`, then failed
 * with a confusing "can't open file 'import'" error).
 *
 * Deterministic, no probing/PATH-searching/trying-multiple-candidates:
 *  - if the first token's *name* already looks like the `litert-lm` CLI
 *    (`litert-lm` or `litert-lm.exe`, any path or none) - use it as-is.
 *  - if the first token's name looks like a Python interpreter AND it has an
 *    actual directory component (i.e. it's a real path into a venv, not a
 *    bare name PATH would resolve unpredictably) - the CLI is the sibling
 *    console-script installed into the same venv: `<venvRoot>\Scripts\
 *    litert-lm.exe` for a Windows-style interpreter path, or `<venvRoot>/bin/
 *    litert-lm` for a posix-style one, where `<venvRoot>` is the interpreter
 *    path's grandparent directory (`.../venv/Scripts/python.exe` ->
 *    `.../venv`, `.../venv/bin/python` -> `.../venv`).
 *  - anything else - including a *bare* Python interpreter name with no
 *    directory component (exactly the nondeterministic case above: which
 *    `python` PATH picks depends on machine/session state, not something
 *    this app controls) - is a hard error: no import command can be safely
 *    derived, so the caller must surface this as a failed rebuild/download
 *    rather than guessing.
 */
export function resolveImportCli(managedCommand: string): ImportCliResolution {
  const binary = tokenizeCommand(managedCommand)[0]
  if (!binary) {
    return {
      ok: false,
      error: `Managed sidecar command is empty - nothing to derive the litert-lm import CLI from: "${managedCommand}"`
    }
  }

  const name = baseName(binary)

  if (LITERT_LM_CLI_NAME.test(name)) {
    return { ok: true, cli: binary }
  }

  if (PYTHON_INTERPRETER_NAME.test(name)) {
    if (binary === name) {
      // A bare interpreter name, e.g. "python" - no directory to derive a
      // venv root from. This is the exact bug: PATH resolution for this is
      // nondeterministic (may pick a system Python instead of the app's
      // venv) - see this function's doc comment.
      return {
        ok: false,
        error:
          `Managed command's binary is a bare Python interpreter ("${binary}") with no path - ` +
          `resolving it via PATH is nondeterministic and may not be the app's own venv. ` +
          `Use the venv's absolute python path in the managed command instead ` +
          `(looked for: an absolute path ending in python/python.exe, so a sibling litert-lm CLI could be derived).`
      }
    }

    const normalized = binary.replace(/\\/g, '/')
    const lastSlash = normalized.lastIndexOf('/')
    const secondLastSlash = normalized.lastIndexOf('/', lastSlash - 1)
    if (secondLastSlash === -1) {
      return {
        ok: false,
        error:
          `Managed command's Python interpreter path ("${binary}") isn't inside a venv's ` +
          `Scripts/bin directory - can't derive a sibling litert-lm CLI from it ` +
          `(looked for at least two directory levels above the interpreter, e.g. ".../venv/Scripts/python.exe" or ".../venv/bin/python").`
      }
    }

    const venvRoot = normalized.slice(0, secondLastSlash)
    const cli = looksWindowsStyle(binary)
      ? `${venvRoot.replace(/\//g, '\\')}\\Scripts\\litert-lm.exe`
      : `${venvRoot}/bin/litert-lm`
    return { ok: true, cli }
  }

  return {
    ok: false,
    error:
      `Can't derive the litert-lm import CLI from managed command's binary "${binary}" ` +
      `(looked for: a name matching litert-lm/litert-lm.exe, or a python/python3/python.exe ` +
      `interpreter path inside a venv's Scripts/bin directory).`
  }
}

const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_READY_POLL_INTERVAL_MS = 500
const MAX_RESTARTS = 3

/**
 * How long to wait for the `ELOQUENT_EFFECTIVE_BACKEND` marker specifically,
 * once a managed command is known to reference `serve_gpu.py` (see
 * `commandReferencesServeGpuWrapper`) - separate from (and longer than) the
 * plain HTTP-readiness timeout, since a cold GPU shader compile can take up
 * to ~15s on top of normal engine load (see `serve_gpu.py`'s doc comment),
 * and this needs headroom above that. If the marker still hasn't arrived by
 * this deadline, the sidecar is reported as an error state, not silently
 * "ready" without having confirmed which backend it's actually running on
 * - this is the fix for a real bug where a sidecar reported ready in 64ms,
 * far too fast for a real eager engine load, because something else
 * entirely was answering its port (see `portGuard.ts`).
 */
export const MARKER_TIMEOUT_MS = 90_000

/** Cap on a single logged child-output line (see `logChildLine`) - long enough to be useful, short enough that a runaway line (e.g. a native stack trace with no newlines) can't blow up main.log. */
const MAX_LOGGED_LINE_LENGTH = 500

/** How many of the managed child's most recent stdout/stderr lines are kept in memory to surface in an error message if it exits unexpectedly (see the 'exit'/'error' handlers) - the fix for a real blind spot: a child that died within its startup window left zero trace of why in main.log. */
const LAST_OUTPUT_LINES_KEPT = 20

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Minimal shell-like tokenizer: splits on whitespace, respecting "..."/'...' quoting. No shell semantics beyond that (no pipes/env expansion) - the process is spawned directly, never through a shell. */
export function tokenizeCommand(template: string): string[] {
  const matches = template.match(/"([^"]*)"|'([^']*)'|\S+/g) ?? []
  return matches.map((m) => {
    if ((m.startsWith('"') && m.endsWith('"')) || (m.startsWith("'") && m.endsWith("'"))) {
      return m.slice(1, -1)
    }
    return m
  })
}

export function renderManagedCommand(
  template: string,
  vars: { modelPath: string; port: number; wrapperPath?: string }
): string[] {
  const rendered = template
    .replaceAll('{modelPath}', vars.modelPath)
    .replaceAll('{port}', String(vars.port))
    .replaceAll('{wrapperPath}', vars.wrapperPath ?? '')
  return tokenizeCommand(rendered)
}

/**
 * Env var name `resources/serve_gpu.py`'s parent watchdog reads (see that
 * file's "Parent watchdog" doc comment) - the Electron main process's own
 * pid, so the wrapper can detect this process dying (crash *or* clean quit
 * alike) and shut itself down instead of leaking the GPU/CPU engine (and
 * its VRAM/RAM) as an orphan until the *next* launch's pid-file hygiene
 * (`portGuard.ts`) notices and kills it. That hygiene step is next-launch
 * cleanup; this env var is what makes crash-time cleanup possible at all.
 */
export const PARENT_PID_ENV_VAR = 'ELOQUENT_PARENT_PID'

/**
 * Builds the full env for a managed spawn: `baseEnv` overridden by any
 * caller-supplied `extraEnv`, with `PARENT_PID_ENV_VAR` always set to
 * `parentPid` last so it can never be shadowed by a custom `env` value.
 * Set unconditionally for *every* managed spawn (not just the GPU wrapper)
 * - a plain `litert-lm serve` child simply never reads it, so this is a
 * harmless no-op there. Pure/testable without spawning a real process.
 */
export function buildManagedChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  extraEnv: Record<string, string> | undefined,
  parentPid: number
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(extraEnv ?? {}),
    [PARENT_PID_ENV_VAR]: String(parentPid)
  }
}

/**
 * Owns the lifecycle of the LiteRT-LM sidecar HTTP server: spawning it (in
 * 'managed' mode) or just pointing at a user-provided URL (in 'external'
 * mode), polling until it answers, and auto-restarting with backoff if it
 * dies unexpectedly. Emits 'state' (SidecarState, message?), 'log'
 * (string), and 'effective-accelerator' (Accelerator - see
 * `getEffectiveAccelerator`) events; never throws out of event handlers.
 */
export class Sidecar extends EventEmitter {
  private proc: ChildProcess | null = null
  private state: SidecarState = 'stopped'
  private restarts = 0
  private stopping = false
  private readonly baseUrl: string
  /** See `getEffectiveAccelerator`. Reset on every (re)spawn. */
  private effectiveAccelerator: Accelerator | null = null
  /** Holds a possibly-incomplete trailing line across stdout chunk boundaries. */
  private stdoutTail = ''
  /** Same as `stdoutTail`, for stderr. */
  private stderrTail = ''
  /** Whether the current spawn's argv references `serve_gpu.py` - see `commandReferencesServeGpuWrapper`. Determines whether `waitUntilReady` requires the effective-backend marker. Reset on every (re)spawn. */
  private markerRequired = false
  /** Ring buffer (see `LAST_OUTPUT_LINES_KEPT`) of the current child's most recent logged output lines, for `buildLastOutputSummary`. Reset on every (re)spawn. */
  private lastOutputLines: string[] = []
  /** Human-readable detail about the most recent unexpected spawn failure/exit, if any - surfaced by `waitUntilReady` when it notices the child is gone. */
  private lastExitDetail: string | undefined

  constructor(private readonly options: SidecarOptions) {
    super()
    this.baseUrl =
      options.mode === 'external'
        ? options.externalUrl.replace(/\/+$/, '')
        : `http://127.0.0.1:${options.port}`
  }

  getBaseUrl(): string {
    return this.baseUrl
  }

  getState(): SidecarState {
    return this.state
  }

  /**
   * The accelerator the managed sidecar's engine actually ended up on, once
   * `serve_gpu.py`'s `ELOQUENT_EFFECTIVE_BACKEND` marker has been observed
   * on its stdout - null until then, or always (mode === 'external', or a
   * managed command that isn't the GPU wrapper - e.g. plain `litert-lm
   * serve`, which never prints the marker). Also emitted as an
   * `'effective-accelerator'` event as soon as it's known.
   */
  getEffectiveAccelerator(): Accelerator | null {
    return this.effectiveAccelerator
  }

  /** Starts (spawning if managed) and resolves once the server answers, or rejects on timeout. */
  async start(): Promise<void> {
    this.stopping = false
    this.setState('starting')

    if (this.options.mode === 'managed') {
      const spawned = await this.spawnManaged()
      if (!spawned) return // setState('error', ...) already called - port hygiene refused to spawn.
    }

    await this.waitUntilReady()
    if (!this.stopping) {
      log.info(`sidecar: ready at ${this.baseUrl}`)
      this.setState('ready')
    }
  }

  /** Stops the sidecar (kills the managed process, if any) and suppresses further auto-restarts. */
  stop(): void {
    this.stopping = true
    this.setState('stopped')
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
    // A clean stop means this pid is no longer meaningful to reclaim on
    // the next spawn - leaving it would just cost one harmless "not alive"
    // check, but removing it now keeps the file honest.
    if (this.options.pidFilePath) removePidFile(this.options.pidFilePath)
  }

  /**
   * Renders the managed command and, if the port-hygiene guard doesn't
   * refuse (see `portGuard.ts`), spawns it and wires up its event handlers.
   * Resolves `true` if a spawn was actually attempted, `false` if it was
   * refused (a matching 'error' state has already been set in that case -
   * callers must not proceed to `waitUntilReady` when this returns false).
   */
  private async spawnManaged(): Promise<boolean> {
    let args: string[]
    try {
      args = renderManagedCommand(this.options.managedCommand, {
        modelPath: this.options.modelPath,
        port: this.options.port,
        wrapperPath: this.options.wrapperPath
      })
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err))
      return false
    }
    const [cmd, ...rest] = args
    if (!cmd) {
      this.setState('error', 'Sidecar command is empty - check the managed command setting.')
      return false
    }

    // A fresh process hasn't reported anything yet - stale state from a
    // previous attempt (e.g. a crash-restart) must not linger and be
    // mistaken for this one's.
    this.effectiveAccelerator = null
    this.stdoutTail = ''
    this.stderrTail = ''
    this.lastOutputLines = []
    this.lastExitDetail = undefined
    this.markerRequired = commandReferencesServeGpuWrapper(args)
    log.info(
      `sidecar: marker rule = ${this.markerRequired ? 'required (command references serve_gpu.py)' : 'not required (command does not reference serve_gpu.py)'}`
    )

    if (this.options.pidFilePath) {
      const guard = await reclaimPortForSpawn({
        port: this.options.port,
        pidFilePath: this.options.pidFilePath
      })
      if (guard.action === 'error') {
        this.setState('error', guard.message)
        return false
      }
    }

    log.info(`sidecar: spawn ${cmd} ${rest.join(' ')}`)
    const child = spawn(cmd, rest, {
      stdio: ['ignore', 'pipe', 'pipe'],
      // Always includes PARENT_PID_ENV_VAR - see its doc comment for why
      // (crash-safe cleanup via serve_gpu.py's parent watchdog).
      env: buildManagedChildEnv(process.env, this.options.env, process.pid)
    })
    this.proc = child

    if (this.options.pidFilePath && child.pid) {
      writePidFile(this.options.pidFilePath, {
        pid: child.pid,
        port: this.options.port,
        startedAt: new Date().toISOString()
      })
    }

    child.stdout?.on('data', (chunk: Buffer) => this.handleStdout(chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.handleStderr(chunk))

    child.on('error', (err) => {
      this.proc = null
      if (this.stopping) return
      const summary = this.buildLastOutputSummary()
      this.lastExitDetail = `spawn failed: ${err.message}${summary ? ` (${summary})` : ''}`
      log.error(`sidecar: ${this.lastExitDetail}`)
      this.setState(
        'error',
        `Failed to start sidecar: ${err.message}${summary ? ` — ${summary}` : ''}`
      )
      if (this.options.pidFilePath) removePidFile(this.options.pidFilePath)
      this.scheduleRestart()
    })

    child.on('exit', (code, signal) => {
      this.proc = null
      if (this.stopping) return
      const summary = this.buildLastOutputSummary()
      this.lastExitDetail = `exited code=${code} signal=${signal ?? 'none'}${summary ? `; ${summary}` : ''}`
      log.warn(`sidecar: ${this.lastExitDetail}`)
      this.setState(
        'error',
        `Sidecar exited unexpectedly (code ${code}, signal ${signal ?? 'none'})${summary ? ` — ${summary}` : ''}.`
      )
      if (this.options.pidFilePath) removePidFile(this.options.pidFilePath)
      this.scheduleRestart()
    })

    return true
  }

  private scheduleRestart(): void {
    if (this.options.mode !== 'managed') return
    if (this.restarts >= MAX_RESTARTS) {
      log.error(`sidecar: exceeded ${MAX_RESTARTS} restart attempts, giving up`)
      this.setState(
        'error',
        `Sidecar crashed ${this.restarts} times; giving up. Check the sidecar command/model path in Settings.`
      )
      this.emit('fatal', new Error('Sidecar exceeded max restart attempts'))
      return
    }
    this.restarts += 1
    const backoffMs = 1000 * 2 ** (this.restarts - 1)
    log.warn(`sidecar: restarting attempt ${this.restarts}/${MAX_RESTARTS} in ${backoffMs}ms`)
    this.setState('restarting', `Restarting sidecar (attempt ${this.restarts}/${MAX_RESTARTS})…`)
    setTimeout(() => {
      if (this.stopping) return
      void (async () => {
        const spawned = await this.spawnManaged()
        if (!spawned) return // setState('error', ...) already called by spawnManaged.
        try {
          await this.waitUntilReady()
          if (!this.stopping) this.setState('ready')
        } catch (err) {
          if (!this.stopping)
            this.setState('error', err instanceof Error ? err.message : String(err))
        }
      })()
    }, backoffMs)
  }

  /**
   * Polls until the sidecar is genuinely ready, per the deterministic rule
   * described on `MARKER_TIMEOUT_MS`/`commandReferencesServeGpuWrapper`:
   * ready = (our own child process is still alive) AND (HTTP responds) AND
   * (the effective-backend marker has been observed, when the managed
   * command references `serve_gpu.py` - which always prints it once an
   * engine has been created or definitively failed to create).
   *
   * The "our own child is alive" check is the fix for the actual bug this
   * all exists to prevent: previously, a managed sidecar whose child had
   * already exited (or was never healthy) could still be reported "ready"
   * because *something else* answered the port's HTTP check - see
   * `portGuard.ts`'s doc comment for the real incident.
   */
  private async waitUntilReady(): Promise<void> {
    const timeoutMs = this.markerRequired
      ? Math.max(this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS, MARKER_TIMEOUT_MS)
      : (this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS)
    const pollMs = this.options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs

    let lastHttpOk = false
    while (Date.now() < deadline) {
      if (this.stopping) return
      if (this.options.mode === 'managed' && !this.proc) {
        throw new Error(
          `Sidecar process exited before becoming ready${this.lastExitDetail ? ` (${this.lastExitDetail})` : '.'}`
        )
      }
      lastHttpOk = await this.pingOnce()
      if (lastHttpOk && (!this.markerRequired || this.effectiveAccelerator !== null)) return
      await sleep(pollMs)
    }

    if (this.markerRequired && lastHttpOk && this.effectiveAccelerator === null) {
      throw new Error(
        `Sidecar answered HTTP at ${this.baseUrl} but never printed the ELOQUENT_EFFECTIVE_BACKEND marker within ${MARKER_TIMEOUT_MS}ms - refusing to report ready without confirming which backend it's actually running on.`
      )
    }
    throw new Error(`Timed out waiting for the sidecar to respond at ${this.baseUrl}`)
  }

  /**
   * `GET /v1/models` - confirmed against a real `litert-lm serve` (verified
   * empirically, see scratchpad/sidecar-verification.md §3/§5 gotcha 5): it
   * responds 200 within ~1-2s of process start, well before the actual
   * model is loaded into memory (loading is lazy, on the first
   * `/v1/chat/completions` request referencing it - so this is a "the HTTP
   * server is up" check, not a "first inference will be fast" guarantee).
   */
  private async pingOnce(): Promise<boolean> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2000)
    try {
      const res = await fetch(`${this.baseUrl}/v1/models`, { signal: controller.signal })
      return res.ok
    } catch {
      return false
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Forwards raw stdout as a 'log' event (unchanged behavior), logs each
   * complete line into main.log (see `logChildLine` - this used to be a
   * blind spot: --verbose sidecar output never reached main.log at all),
   * and scans complete lines for `serve_gpu.py`'s `ELOQUENT_EFFECTIVE_BACKEND`
   * marker - buffered across chunk boundaries since a pipe read can split a
   * line arbitrarily.
   */
  private handleStdout(chunk: Buffer): void {
    const text = chunk.toString('utf-8')
    this.emit('log', text)

    const combined = this.stdoutTail + text
    const lines = combined.split('\n')
    this.stdoutTail = lines.pop() ?? ''
    for (const line of lines) {
      this.logChildLine('out', line)
      const accelerator = parseEffectiveBackendLine(line)
      if (accelerator) {
        log.info(`sidecar: effective-backend=${accelerator}`)
        this.effectiveAccelerator = accelerator
        this.emit('effective-accelerator', accelerator)
      }
    }
  }

  /** Same treatment as `handleStdout`, minus the marker scan - stderr never carries the marker, only diagnostics (GPU fallback notices, native stack traces, etc). */
  private handleStderr(chunk: Buffer): void {
    const text = chunk.toString('utf-8')
    this.emit('log', text)

    const combined = this.stderrTail + text
    const lines = combined.split('\n')
    this.stderrTail = lines.pop() ?? ''
    for (const line of lines) this.logChildLine('err', line)
  }

  /**
   * Writes one complete line of the managed child's stdout/stderr into
   * main.log as `sidecar-out: ...`/`sidecar-err: ...` (this is the fix for
   * a real logging blind spot: --verbose child output never reached disk,
   * only an in-memory 'log' event nothing subscribed to) and keeps it in a
   * small ring buffer (`lastOutputLines`) so an unexpected spawn
   * failure/exit can surface the last few lines in its error message
   * instead of a bare exit code. Blank lines are skipped (pure noise);
   * long lines are capped (see `MAX_LOGGED_LINE_LENGTH`) so a single
   * runaway line can't blow up the log.
   */
  private logChildLine(stream: 'out' | 'err', rawLine: string): void {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim().length === 0) return
    const truncated =
      line.length > MAX_LOGGED_LINE_LENGTH ? `${line.slice(0, MAX_LOGGED_LINE_LENGTH)}…` : line
    log.info(`sidecar-${stream}: ${truncated}`)
    this.lastOutputLines.push(truncated)
    if (this.lastOutputLines.length > LAST_OUTPUT_LINES_KEPT) this.lastOutputLines.shift()
  }

  /** Renders `lastOutputLines` into a single capped string for an error message - `''` if nothing's been logged yet (e.g. the child died before writing anything). */
  private buildLastOutputSummary(): string {
    if (this.lastOutputLines.length === 0) return ''
    const joined = `last output: ${this.lastOutputLines.join(' | ')}`
    return joined.length > 1000 ? `${joined.slice(0, 1000)}…` : joined
  }

  private setState(state: SidecarState, message?: string): void {
    this.state = state
    this.emit('state', state, message)
  }
}
