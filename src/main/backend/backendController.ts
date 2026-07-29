import { EventEmitter } from 'events'
import type { BackendStatus, InferenceBackend } from '../../shared/backend'
import type { SettingsStore } from '../store/settingsStore'
import type { ModelManager } from './modelManager'
import { MockBackend } from './mockBackend'
import { LitertBackend } from './litertBackend'
import { Sidecar } from './sidecar'

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
 * settings change. This is the one place that knows about both
 * `MockBackend` and `LitertBackend` - everything else (IPC, renderer) only
 * ever sees the current `InferenceBackend` via `getBackend()`.
 */
export class BackendController extends EventEmitter {
  private backend: InferenceBackend
  private sidecar: Sidecar | null = null
  private status: BackendStatus = { state: 'mock' }
  /** Bumped on every rebuild so a slow-to-start previous attempt can detect it's stale and back off. */
  private generation = 0

  constructor(
    private readonly settingsStore: SettingsStore,
    private readonly modelManager: ModelManager
  ) {
    super()
    this.backend = new MockBackend()
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
    const settings = this.settingsStore.get()
    const previousSidecar = this.sidecar

    if (settings.backend === 'mock') {
      this.sidecar = null
      this.setBackend(new MockBackend())
      this.setStatus({ state: 'mock' })
      previousSidecar?.stop()
      return
    }

    this.setStatus({ state: 'starting' })

    try {
      const modelPath = this.modelManager.getInstalledModelPath(settings.modelId)
      if (settings.sidecar.mode === 'managed' && !modelPath) {
        throw new Error(
          `The selected model (${settings.modelId}) isn't downloaded yet - install it from Settings first.`
        )
      }

      const sidecar = new Sidecar({
        mode: settings.sidecar.mode,
        externalUrl: settings.sidecar.externalUrl,
        managedCommand: settings.sidecar.managedCommand,
        modelPath: modelPath ?? '',
        port: settings.sidecar.port
      })

      sidecar.on('state', (state, message) => {
        if (generation !== this.generation) return
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

      await sidecar.start()

      if (generation !== this.generation) {
        // A newer rebuild superseded us while we were waiting on start() -
        // discard this one instead of clobbering the newer backend.
        sidecar.stop()
        return
      }

      this.sidecar = sidecar
      this.setBackend(
        new LitertBackend({
          getBaseUrl: () => sidecar.getBaseUrl(),
          modelId: settings.modelId,
          getVocabulary: () => this.settingsStore.get().customVocabulary
        })
      )
      this.setStatus({ state: 'ready' })
      previousSidecar?.stop()
    } catch (err) {
      if (generation !== this.generation) return
      const message = err instanceof Error ? err.message : String(err)
      this.setStatus({ state: 'error', message })
      this.setBackend(new UnavailableBackend(message))
      previousSidecar?.stop()
    }
  }

  private setBackend(backend: InferenceBackend): void {
    this.backend = backend
    this.emit('backend-changed', backend)
  }

  private setStatus(status: BackendStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /** Call on app quit. */
  dispose(): void {
    this.sidecar?.stop()
  }
}
