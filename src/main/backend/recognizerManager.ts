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
 * `litert-lm import` step - none of which apply here. This is two small
 * files fetched once, used directly off disk by `resources/asr.py`, and
 * never handed to `litert-lm` at all. Folding it into the LLM's machinery
 * would have meant a fake catalog entry and an import that does nothing,
 * leaking a non-LLM artifact into `Settings.modelId` and the model-picker
 * UI.
 */

/**
 * whisper-acft: Whisper fine-tuned for short, fixed-length audio windows,
 * which is what dictation is. Apache-2.0 and ungated, so the unauthenticated
 * HuggingFace fetches below (Blurt has no HF token handling at all) work.
 *
 * Two sizes, because a mid-recording tick and the one final pass want
 * opposite things. Measured on 25 LibriSpeech clips (463 reference words) on
 * a real Windows machine, CPU:
 *
 *     tiny.en    61 MB   10.37% WER    442ms per 3s window
 *     base.en   103 MB    6.26% WER    651ms
 *     small.en  289 MB    3.46% WER   2157ms
 *     (Gemma 4 E2B, 2,588 MB, for reference: 6.48%)
 *
 * `base.en` drives the live transcript: its window cost is paid again every
 * tick, and at 651ms it keeps the on-screen cadence near 800ms. `small.en`
 * runs the single final pass, whose output is what gets pasted and saved -
 * roughly half Gemma's error rate, and its 2157ms is paid once.
 *
 * `tiny.en` was shipped briefly on the strength of a 6-clip run that put it
 * at 4.14%. A 25-clip run put it at 10.37%, worse than the Gemma path it
 * replaced. Kept here as a warning about the sample size, not as an option.
 *
 * The 30s builds rather than 5s/10s: those hard-truncate anything longer,
 * and truncation is silent - a 12s clip through the 10s build simply loses
 * its ending, which measured as 18.8% WER purely from the missing words.
 * English-only; the multilingual builds are the same sizes if that ever
 * needs revisiting.
 */
export const RECOGNIZER_REPO = 'litert-community/whisper-acft'
/** Drives the live transcript - see the table above. */
export const RECOGNIZER_LIVE_FILE = 'base.en/acft_whisper_base.en_30s_drq.tflite'
/** Runs the single final pass, whose output is pasted and saved. */
export const RECOGNIZER_FINAL_FILE = 'small.en/acft_whisper_small.en_30s_drq.tflite'

/**
 * The decoder emits Whisper token ids, so it needs Whisper's own vocabulary
 * to become text. It comes from the matching `openai/whisper-*` repo rather
 * than from the recogniser's, which ships weights only.
 *
 * One tokenizer serves both models: every English Whisper build shares the
 * same 51864-token vocabulary regardless of size. It does have to match the
 * *language* build though - the multilingual vocabulary is 51865, and the
 * wrong one shifts every id past the mismatch and produces fluent-looking
 * nonsense rather than an error.
 */
export const TOKENIZER_REPO = 'openai/whisper-tiny.en'
export const TOKENIZER_FILE = 'tokenizer.json'

export interface RecognizerPaths {
  /** The fast recogniser behind the live transcript. */
  modelPath: string
  /** The accurate recogniser behind the final pass. */
  finalModelPath: string
  tokenizerPath: string
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
    return {
      modelPath: join(this.dir, 'recognizer-live.tflite'),
      finalModelPath: join(this.dir, 'recognizer-final.tflite'),
      tokenizerPath: join(this.dir, 'tokenizer.json')
    }
  }

  /** All three files present. None is useful alone, so this is deliberately all-or-nothing. */
  isInstalled(): boolean {
    const { modelPath, finalModelPath, tokenizerPath } = this.getPaths()
    return existsSync(modelPath) && existsSync(finalModelPath) && existsSync(tokenizerPath)
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
   * deleted) it fetches ~61 MB, which is why the caller reports it as a
   * startup step rather than doing it silently.
   */
  async ensureDownloaded(): Promise<RecognizerPaths> {
    if (this.isInstalled()) {
      this.setStatus({ state: 'ready', receivedBytes: 0, totalBytes: null })
      return this.getPaths()
    }
    if (this.inFlight) return this.inFlight

    this.inFlight = this.downloadBoth().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async downloadBoth(): Promise<RecognizerPaths> {
    const paths = this.getPaths()
    log.info('recognizer: downloading speech recognition model')
    this.setStatus({ state: 'downloading', receivedBytes: 0, totalBytes: null })
    try {
      // Weights before the tokenizer, and the largest weights first: each
      // file is only renamed into place once complete, so a failure part way
      // through leaves the remaining files absent and the all-or-nothing
      // isInstalled() check cannot mistake a partial install for a finished
      // one.
      await this.downloadFile(
        `https://huggingface.co/${RECOGNIZER_REPO}/resolve/main/${RECOGNIZER_FINAL_FILE}`,
        paths.finalModelPath,
        true
      )
      await this.downloadFile(
        `https://huggingface.co/${RECOGNIZER_REPO}/resolve/main/${RECOGNIZER_LIVE_FILE}`,
        paths.modelPath,
        true
      )
      await this.downloadFile(
        `https://huggingface.co/${TOKENIZER_REPO}/resolve/main/${TOKENIZER_FILE}`,
        paths.tokenizerPath,
        false
      )
      log.info('recognizer: ready')
      this.setStatus({ state: 'ready', receivedBytes: 0, totalBytes: null })
      return paths
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
    reportProgress: boolean
  ): Promise<void> {
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

    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (!value?.length) continue
        await new Promise<void>((resolve, reject) => {
          stream.write(Buffer.from(value), (writeErr) => (writeErr ? reject(writeErr) : resolve()))
        })
        received += value.length
        if (reportProgress) {
          this.setStatus({ state: 'downloading', receivedBytes: received, totalBytes })
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
  }
}
