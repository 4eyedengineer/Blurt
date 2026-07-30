import { spawn, type ChildProcess } from 'child_process'
import { EventEmitter } from 'events'

export type SidecarState = 'stopped' | 'starting' | 'ready' | 'restarting' | 'error'

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
}

/** Extracts the executable name/path from a managed-command template (its first whitespace/quote-aware token), e.g. for shelling out to the same `litert-lm` binary for `import` as `serve` uses. */
export function getManagedCommandBinary(template: string): string {
  return tokenizeCommand(template)[0] ?? 'litert-lm'
}

const DEFAULT_READY_TIMEOUT_MS = 60_000
const DEFAULT_READY_POLL_INTERVAL_MS = 500
const MAX_RESTARTS = 3

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
 * Owns the lifecycle of the LiteRT-LM sidecar HTTP server: spawning it (in
 * 'managed' mode) or just pointing at a user-provided URL (in 'external'
 * mode), polling until it answers, and auto-restarting with backoff if it
 * dies unexpectedly. Emits 'state' (SidecarState, message?) and 'log'
 * (string) events; never throws out of event handlers.
 */
export class Sidecar extends EventEmitter {
  private proc: ChildProcess | null = null
  private state: SidecarState = 'stopped'
  private restarts = 0
  private stopping = false
  private readonly baseUrl: string

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

  /** Starts (spawning if managed) and resolves once the server answers, or rejects on timeout. */
  async start(): Promise<void> {
    this.stopping = false
    this.setState('starting')

    if (this.options.mode === 'managed') {
      this.spawnManaged()
    }

    await this.waitUntilReady()
    if (!this.stopping) this.setState('ready')
  }

  /** Stops the sidecar (kills the managed process, if any) and suppresses further auto-restarts. */
  stop(): void {
    this.stopping = true
    this.setState('stopped')
    if (this.proc) {
      this.proc.kill()
      this.proc = null
    }
  }

  private spawnManaged(): void {
    let args: string[]
    try {
      args = renderManagedCommand(this.options.managedCommand, {
        modelPath: this.options.modelPath,
        port: this.options.port,
        wrapperPath: this.options.wrapperPath
      })
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : String(err))
      return
    }
    const [cmd, ...rest] = args
    if (!cmd) {
      this.setState('error', 'Sidecar command is empty - check the managed command setting.')
      return
    }

    const child = spawn(cmd, rest, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: this.options.env ? { ...process.env, ...this.options.env } : process.env
    })
    this.proc = child

    child.stdout?.on('data', (chunk: Buffer) => this.emit('log', chunk.toString('utf-8')))
    child.stderr?.on('data', (chunk: Buffer) => this.emit('log', chunk.toString('utf-8')))

    child.on('error', (err) => {
      this.proc = null
      if (this.stopping) return
      this.setState('error', `Failed to start sidecar: ${err.message}`)
      this.scheduleRestart()
    })

    child.on('exit', (code, signal) => {
      this.proc = null
      if (this.stopping) return
      this.setState(
        'error',
        `Sidecar exited unexpectedly (code ${code}, signal ${signal ?? 'none'}).`
      )
      this.scheduleRestart()
    })
  }

  private scheduleRestart(): void {
    if (this.options.mode !== 'managed') return
    if (this.restarts >= MAX_RESTARTS) {
      this.setState(
        'error',
        `Sidecar crashed ${this.restarts} times; giving up. Check the sidecar command/model path in Settings.`
      )
      this.emit('fatal', new Error('Sidecar exceeded max restart attempts'))
      return
    }
    this.restarts += 1
    const backoffMs = 1000 * 2 ** (this.restarts - 1)
    this.setState('restarting', `Restarting sidecar (attempt ${this.restarts}/${MAX_RESTARTS})…`)
    setTimeout(() => {
      if (this.stopping) return
      this.spawnManaged()
      this.waitUntilReady()
        .then(() => {
          if (!this.stopping) this.setState('ready')
        })
        .catch((err) => {
          if (!this.stopping)
            this.setState('error', err instanceof Error ? err.message : String(err))
        })
    }, backoffMs)
  }

  private async waitUntilReady(): Promise<void> {
    const timeoutMs = this.options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS
    const pollMs = this.options.readyPollIntervalMs ?? DEFAULT_READY_POLL_INTERVAL_MS
    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      if (this.stopping) return
      if (await this.pingOnce()) return
      await sleep(pollMs)
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

  private setState(state: SidecarState, message?: string): void {
    this.state = state
    this.emit('state', state, message)
  }
}
