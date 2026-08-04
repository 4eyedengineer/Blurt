import { EventEmitter } from 'events'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'fs'
import { join } from 'path'
import { log } from '../log'

/**
 * The speech recogniser that turns audio into text, downloaded and kept
 * separately from the language model.
 *
 * Deliberately not part of `ModelManager`. That class is built around
 * `ModelId`, a catalog entry, a VRAM/RAM requirements gate and a
 * `litert-lm import` step - none of which apply here. These are files
 * fetched once, read directly off disk by `resources/asr.py`, and never
 * handed to `litert-lm` at all. Folding it into the LLM's machinery
 * would have meant a fake catalog entry and an import that does nothing,
 * leaking a non-LLM artifact into `Settings.modelId` and the model-picker
 * UI.
 */

/**
 * NVIDIA Parakeet TDT 0.6B, converted to ONNX, int8.
 *
 * Measured on this project against 25 LibriSpeech clips (463 reference
 * words) on a Windows machine with an RTX 3060, same audio and scorer
 * throughout:
 *
 *     Engine                      WER    median   29s clip   hardware
 *     parakeet-tdt-0.6b (this)   1.94%    328ms      359ms   GPU (DirectML)
 *     whisper-acft small.en      3.46%   3716ms    20561ms   CPU
 *     whisper-acft base.en       6.26%   1301ms     5229ms   CPU
 *     Gemma 4 E2B                6.48%    948ms     3543ms   GPU
 *     whisper-acft tiny.en      10.37%    748ms          -   CPU
 *
 * Most accurate and by a wide margin the fastest, because it is the only
 * recogniser here that reaches the GPU - the whisper `.tflite` builds cannot
 * (see asr.py for the two dead ends that established that). Fast enough that
 * one model serves both the live ticks and the final pass; an earlier
 * CPU-only recogniser needed those split.
 *
 * CC-BY-4.0, which requires attribution and nothing else - see NOTICE. It is
 * ungated, so the unauthenticated HuggingFace fetches below (Blurt has no HF
 * token handling at all) work.
 *
 * English-only. `nemo-parakeet-tdt-0.6b-v3` is the multilingual sibling at
 * the same size if that ever needs revisiting.
 */
export const RECOGNIZER_REPO = 'istupakov/parakeet-tdt-0.6b-v2-onnx'

/**
 * Exactly the files onnx-asr needs to load this model from a local
 * directory, and no more. The repo also ships fp32 weights - an
 * `encoder-model.onnx` plus a 2.4 GB `.onnx.data` - which would nearly
 * quadruple the download for a precision nothing here uses.
 */
export const RECOGNIZER_FILES = [
  'encoder-model.int8.onnx',
  'decoder_joint-model.int8.onnx',
  'nemo128.onnx',
  'vocab.txt',
  'config.json'
]

/** Roughly what RECOGNIZER_FILES weighs, for the progress bar's total before any response arrives. */
export const RECOGNIZER_APPROX_BYTES = 661_000_000

/**
 * Minimum gap between byte-count status emissions while downloading. Same
 * reasoning as `PROGRESS_EMIT_INTERVAL_MS` in modelManager.ts: every emit is
 * a status event, and one per chunk is roughly 40,000 of them across this
 * ~661 MB set to animate a bar nobody can read that fast. State transitions
 * (downloading, ready, error) are never throttled.
 */
const PROGRESS_EMIT_INTERVAL_MS = 200

export interface RecognizerPaths {
  /** Directory holding RECOGNIZER_FILES - onnx-asr loads the model from here. */
  modelDir: string
}

export type RecognizerState = 'missing' | 'downloading' | 'ready' | 'error'

export interface RecognizerStatus {
  state: RecognizerState
  receivedBytes: number
  totalBytes: number | null
  error?: string
}

export class RecognizerManager extends EventEmitter {
  private readonly dir: string
  private status: RecognizerStatus = { state: 'missing', receivedBytes: 0, totalBytes: null }
  /** In-flight download, so two callers (a rebuild and a retry, say) share one fetch instead of racing on the same .part file. */
  private inFlight: Promise<RecognizerPaths> | null = null

  constructor(userDataDir: string) {
    super()
    this.dir = join(userDataDir, 'recognizer')
    mkdirSync(this.dir, { recursive: true })
    if (this.isInstalled()) {
      this.status = { state: 'ready', receivedBytes: 0, totalBytes: null }
    }
  }

  getPaths(): RecognizerPaths {
    return { modelDir: this.dir }
  }

  /** Every file present. None is useful alone, so this is deliberately all-or-nothing. */
  isInstalled(): boolean {
    return RECOGNIZER_FILES.every((name) => existsSync(join(this.dir, name)))
  }

  getStatus(): RecognizerStatus {
    return this.status
  }

  private setStatus(status: RecognizerStatus): void {
    this.status = status
    this.emit('status', status)
  }

  /**
   * Returns the recogniser's paths, downloading it first if it isn't there.
   *
   * Called on every backend rebuild, so the common case is an existence
   * check and nothing else. On a fresh install (or after the files are
   * deleted) it fetches ~661 MB, which is why the caller reports it as a
   * startup step rather than doing it silently.
   */
  async ensureDownloaded(): Promise<RecognizerPaths> {
    if (this.isInstalled()) {
      this.setStatus({ state: 'ready', receivedBytes: 0, totalBytes: null })
      return this.getPaths()
    }
    if (this.inFlight) return this.inFlight

    this.inFlight = this.downloadAll().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async downloadAll(): Promise<RecognizerPaths> {
    log.info(`recognizer: downloading speech recognition model (${RECOGNIZER_FILES.length} files)`)
    this.setStatus({
      state: 'downloading',
      receivedBytes: 0,
      totalBytes: RECOGNIZER_APPROX_BYTES
    })
    try {
      // Largest first, and each file only renamed into place once complete,
      // so a failure part way through leaves the rest absent and the
      // all-or-nothing isInstalled() check cannot mistake a partial install
      // for a finished one.
      let received = 0
      for (const name of RECOGNIZER_FILES) {
        received += await this.downloadFile(
          `https://huggingface.co/${RECOGNIZER_REPO}/resolve/main/${name}`,
          join(this.dir, name),
          received
        )
      }
      log.info('recognizer: ready')
      this.setStatus({ state: 'ready', receivedBytes: 0, totalBytes: null })
      return this.getPaths()
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err)
      log.error(`recognizer: download failed: ${detail}`)
      this.setStatus({
        state: 'error',
        receivedBytes: 0,
        totalBytes: null,
        error: 'Could not download the speech recognition model.'
      })
      throw err
    }
  }

  /**
   * Downloads one file to a `.part` and renames it into place only once the
   * stream completes, so an interrupted download can never leave a truncated
   * file that `isInstalled()` would count as present.
   */
  private async downloadFile(
    url: string,
    destination: string,
    /** Bytes already fetched for earlier files, so progress spans the whole set rather than restarting per file. */
    alreadyReceived: number
  ): Promise<number> {
    const partPath = `${destination}.part`
    if (existsSync(partPath)) unlinkSync(partPath)

    const res = await fetch(url, { redirect: 'follow' })
    if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
    if (!res.body) throw new Error(`Empty response body fetching ${url}`)

    const lengthHeader = res.headers.get('content-length')
    const totalBytes = lengthHeader ? Number(lengthHeader) : null
    const stream = createWriteStream(partPath, { flags: 'w' })
    const reader = res.body.getReader()
    let received = 0

    let lastProgressAtMs = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value?.length) continue
        await new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(value), (writeErr) => (writeErr ? reject(writeErr) : resolve()))
        })
        received += value.length
        // Throttled - see PROGRESS_EMIT_INTERVAL_MS.
        const nowMs = Date.now()
        if (nowMs - lastProgressAtMs >= PROGRESS_EMIT_INTERVAL_MS) {
          lastProgressAtMs = nowMs
          this.setStatus({
            state: 'downloading',
            receivedBytes: alreadyReceived + received,
            totalBytes: RECOGNIZER_APPROX_BYTES
          })
        }
      }
    } finally {
      await new Promise<void>((resolve) => stream.close(() => resolve()))
    }

    // A truncated body still closes cleanly, so compare against the length
    // the server promised before treating this as a complete file.
    const writtenBytes = statSync(partPath).size
    if (totalBytes !== null && writtenBytes !== totalBytes) {
      // Size read before the unlink, not after - stat-ing a file this line
      // just deleted throws, replacing a useful "ended early" message with
      // an ENOENT from the error path itself.
      unlinkSync(partPath)
      throw new Error(`Download of ${url} ended early (${writtenBytes} of ${totalBytes} bytes)`)
    }

    if (existsSync(destination)) unlinkSync(destination)
    renameSync(partPath, destination)
    return writtenBytes
  }
}
