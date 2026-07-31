import { EventEmitter } from 'events'
import { join } from 'path'
import type { BackendStatus, InferenceBackend } from '../../shared/backend'
import type { Accelerator } from '../../shared/types'
import { getCatalogEntry } from '../../shared/models'
import type { SettingsStore } from '../store/settingsStore'
import type { ModelManager } from './modelManager'
import { LitertBackend } from './litertBackend'
import { resolveManagedCliForImport, Sidecar } from './sidecar'
import { resolveServeGpuScriptPath } from './gpuWrapperPath'
import type { VenvPaths } from '../runtime/venvResolver'
import { log } from '../log'

/**
 * A stand-in InferenceBackend used whenever the real backend failed to
 * start (bad sidecar command, model not downloaded, sidecar crashed past
 * its restart budget, ...). Every Promise-returning method rejects with a
 * clear message; `pushAudio`/`onPartialTranscript` no-op rather than throw
 * since they don't return a Promise the caller could catch. Paired with the
 * status pill (which will show 'error' with the same message) this keeps
 * the app honest about not actually being backed by a working model,
 * instead of silently falling back to mocked output.
 */
class UnavailableBackend implements InferenceBackend {
  constructor(private readonly message: string) {}

  async startSession(): Promise<string> {
    throw new Error(this.message)
  }
  pushAudio(): void {
    // no-op: nothing to push to.
  }
  async endSession(): Promise<string> {
    throw new Error(this.message)
  }
  onPartialTranscript(): () => void {
    return () => {}
  }
  onTextStreamProgress(): () => void {
    return () => {}
  }
  async cleanup(): Promise<string> {
    throw new Error(this.message)
  }
  async transform(): Promise<string> {
    throw new Error(this.message)
  }
  async voiceEdit(): Promise<string> {
    throw new Error(this.message)
  }
}

/**
 * Builds the active InferenceBackend from current settings, and rebuilds it
 * (disposing the old sidecar/backend cleanly) whenever the backend-relevant
 * settings change. This is the one place that knows about `LitertBackend` -
 * everything else (IPC, renderer) only ever sees the current
 * `InferenceBackend` via `getBackend()`.
 */
export class BackendController extends EventEmitter {
  private backend: InferenceBackend
  private sidecar: Sidecar | null = null
  private status: BackendStatus = { state: 'starting' }
  /** Bumped on every rebuild so a slow-to-start previous attempt can detect it's stale and back off. */
  private generation = 0
  /** See `BackendStatus.effectiveAccelerator`. Reset at the start of every rebuild. */
  private effectiveAccelerator: Accelerator | undefined

  /** Fixed location for the managed sidecar's pid-file (see `portGuard.ts`) - one per app install, not per rebuild, so a stale sidecar from a *previous run of the app itself* (not just a previous rebuild within this run) can still be found and reclaimed. */
  private readonly sidecarPidFilePath: string

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly modelManager: ModelManager,
    userDataDir: string,
    /** Passed straight through to LitertBackend as `debugAudioDir` - see its doc comment / BLURT_DEBUG_AUDIO. Optional so tests/mocks don't need to care. */
    private readonly debugAudioDir?: string,
    /**
     * The self-managed runtime venv's resolved absolute paths (see
     * `runtime/venvResolver.ts`), resolved once at app startup (main/index.ts)
     * and reused for the app's lifetime - undefined only on non-Windows dev
     * builds, where `DEFAULT_MANAGED_COMMAND`'s `{venvPython}`/
     * `{litertLmCli}` placeholders are never actually reached in practice
     * (there's no `%LOCALAPPDATA%` venv to point at, so a contributor must
     * hand-edit the managed command or use 'external' mode instead - see
     * that constant's doc comment).
     */
    private readonly venvPaths?: VenvPaths
  ) {
    super()
    // Replaced immediately by the first rebuild() (see main/index.ts, which
    // calls it right after construction) - this is just a safe placeholder
    // so `backend` is never left `undefined` in between.
    this.backend = new UnavailableBackend('Backend not yet initialized - call rebuild() first.')
    this.sidecarPidFilePath = join(userDataDir, 'sidecar.pid')
  }

  getBackend(): InferenceBackend {
    return this.backend
  }

  getStatus(): BackendStatus {
    return this.status
  }

  /** Call once at startup, and again after any settings change that could affect the backend. */
  async rebuild(): Promise<void> {
    const generation = ++this.generation
    log.info('backend: rebuild start')
    const settings = this.settingsStore.get()
    const previousSidecar = this.sidecar
    // Hoisted so the catch below can stop the sidecar *this* attempt built,
    // not just the previous one - a sidecar that failed to start still owns
    // a spawned child and its own restart timers, and leaving it running
    // meant a failed rebuild kept emitting state changes forever.
    let sidecar: Sidecar | null = null
    // Nothing's been observed about a not-yet-started (or freshly rebuilt)
    // sidecar's real backend yet - a stale value from a previous attempt
    // must not linger and be shown as if it were current.
    this.effectiveAccelerator = undefined

    this.setStatus({ state: 'starting' })

    try {
      const modelPath = this.modelManager.getInstalledModelPath(settings.modelId)
      if (settings.sidecar.mode === 'managed' && !modelPath) {
        throw new Error(
          `The selected model (${settings.modelId}) isn't downloaded yet - install it from Settings first.`
        )
      }

      // The downloaded .litertlm file alone isn't enough for a managed
      // sidecar to serve it - `litert-lm serve` only recognizes models that
      // have gone through `litert-lm import <file> <alias>` (see
      // ModelManager's class doc).
      // Normally `ModelManager.download()` does this as its last step, but
      // guard here too in case the import step failed previously, or the
      // sandboxed LITERT_LM_DIR was cleared independently of the download.
      if (settings.sidecar.mode === 'managed' && !this.modelManager.isImported(settings.modelId)) {
        const cliResolution = resolveManagedCliForImport(
          settings.sidecar.managedCommand,
          this.venvPaths
        )
        if (!cliResolution.ok) {
          throw new Error(`Cannot import model: ${cliResolution.error}`)
        }
        await this.modelManager.importModel(settings.modelId, cliResolution.cli)
        if (generation !== this.generation) return
      }

      sidecar = new Sidecar({
        mode: settings.sidecar.mode,
        externalUrl: settings.sidecar.externalUrl,
        managedCommand: settings.sidecar.managedCommand,
        modelPath: modelPath ?? '',
        port: settings.sidecar.port,
        pidFilePath: this.sidecarPidFilePath,
        // Only meaningful if managedCommand references {wrapperPath} (the
        // default one does - see DEFAULT_MANAGED_COMMAND in
        // shared/types.ts); harmless no-op otherwise.
        wrapperPath: resolveServeGpuScriptPath(),
        // Only meaningful if managedCommand references {venvPython}/
        // {litertLmCli} (the default one does); harmless no-op
        // otherwise - see this class's `venvPaths` field doc comment.
        venvPython: this.venvPaths?.pythonExe,
        litertLmCli: this.venvPaths?.litertLmExe,
        env: {
          // Points a managed `litert-lm serve` (and the `import` step above)
          // at the same sandboxed model store, entirely separate from the
          // user's real `~/.litert-lm` - see ModelManager.getLitertLmDir().
          LITERT_LM_DIR: this.modelManager.getLitertLmDir(),
          // Only read by `resources/serve_gpu.py` (see its "Eager engine
          // creation" doc comment) - lets it load the engine synchronously
          // at startup instead of on the first request, so the effective
          // backend is known (and truthfully reported) before the sidecar
          // ever looks ready. Harmless/unused for a plain `litert-lm serve`
          // managed command (e.g. a hand-edited external one).
          BLURT_EAGER_MODEL_ID: getCatalogEntry(settings.modelId).alias
        }
      })

      sidecar.on('state', (state, message) => {
        if (generation !== this.generation) return
        // Anything other than 'ready' means the engine we observed the
        // accelerator from is gone (crashed, restarting, stopped) - what it
        // was running on is no longer a fact about anything currently
        // running, so forget it rather than carry it into the next status.
        if (state !== 'ready') this.effectiveAccelerator = undefined
        if (state === 'ready') this.setStatus({ state: 'ready' })
        else if (state === 'error') this.setStatus({ state: 'error', message })
        else if (state === 'starting' || state === 'restarting') {
          this.setStatus({ state: 'starting', message })
        }
      })
      sidecar.on('fatal', (err: Error) => {
        if (generation !== this.generation) return
        this.setStatus({ state: 'error', message: err.message })
      })
      sidecar.on('effective-accelerator', (accelerator: Accelerator) => {
        if (generation !== this.generation) return
        this.effectiveAccelerator = accelerator
        this.setStatus({ ...this.status })
      })

      await sidecar.start()

      if (generation !== this.generation) {
        // A newer rebuild superseded us while we were waiting on start() -
        // discard this one instead of clobbering the newer backend.
        sidecar.stop()
        return
      }

      this.sidecar = sidecar
      const startedSidecar = sidecar
      // The server has no idea what our internal ModelId ("gemma-4-e2b")
      // means - every request's `model` field must be the alias it was
      // `litert-lm import`-ed as (e.g. "e2b") - verified empirically
      // against a running server. See ModelCatalogEntry.alias.
      const backend = new LitertBackend({
        getBaseUrl: () => startedSidecar.getBaseUrl(),
        modelId: getCatalogEntry(settings.modelId).alias,
        getVocabulary: () => this.settingsStore.get().customVocabulary,
        debugAudioDir: this.debugAudioDir
      })
      this.setBackend(backend)
      this.setStatus({ state: 'ready' })
      log.info(`backend: ready (model=${settings.modelId})`)
      previousSidecar?.stop()
      // Fire-and-forget: primes the sidecar's lazy model load right away
      // instead of making the user's first real utterance pay the ~5s
      // cold-start cost (see LitertBackend.warmup doc comment).
      void backend.warmup()
    } catch (err) {
      if (generation !== this.generation) return
      const message = err instanceof Error ? err.message : String(err)
      log.error(`backend: rebuild failed: ${message}`)
      this.setStatus({ state: 'error', message })
      this.setBackend(new UnavailableBackend(message))
      sidecar?.stop()
      previousSidecar?.stop()
    }
  }

  private setBackend(backend: InferenceBackend): void {
    this.backend = backend
    this.emit('backend-changed', backend)
  }

  /**
   * Folds in the latest observed `effectiveAccelerator` (see that field's
   * doc comment on `BackendStatus`) so individual call sites above don't
   * each need to carry it forward - but only onto a 'ready' status. While
   * starting, nothing is running yet to have an accelerator; in an error
   * state, whatever was observed belongs to an engine that is now gone.
   * Reporting it in either case is a claim about a process that isn't
   * serving anything.
   */
  private setStatus(status: BackendStatus): void {
    this.status =
      status.state === 'ready'
        ? {
            ...status,
            effectiveAccelerator: status.effectiveAccelerator ?? this.effectiveAccelerator
          }
        : { ...status, effectiveAccelerator: undefined }
    this.emit('status', this.status)
  }

  /** Call on app quit. */
  dispose(): void {
    this.sidecar?.stop()
  }
}
