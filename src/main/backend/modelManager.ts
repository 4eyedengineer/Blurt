import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
  type WriteStream
} from 'fs'
import { join } from 'path'
import { spawn } from 'child_process'
import { EventEmitter } from 'events'
import type { ModelId } from '../../shared/types'
import {
  MODEL_CATALOG,
  getCatalogEntry,
  type InstalledModelInfo,
  type ModelDownloadProgress,
  type ModelDownloadState
} from '../../shared/models'
import { log } from '../log'

interface HfSibling {
  rfilename: string
}

interface HfModelInfo {
  siblings?: HfSibling[]
}

function writeChunk(stream: WriteStream, chunk: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(chunk, (err) => (err ? reject(err) : resolve()))
  })
}

function closeStream(stream: WriteStream): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.end((err?: Error | null) => (err ? reject(err) : resolve()))
  })
}

/**
 * Downloads `.litertlm` model files from the (ungated) `litert-community/*`
 * HuggingFace mirrors into `<userData>/models/`, resolving the actual
 * filename inside each repo via the HF API at download time (repo
 * maintainers can and do rename files across releases, so hardcoding a
 * filename would be fragile). Local files are always stored as
 * `<modelId>.litertlm` regardless of the upstream filename, so "is this
 * model installed" is a plain existence check - no separate manifest to
 * keep in sync.
 *
 * A downloaded file isn't enough on its own, though: the real `litert-lm
 * serve` only recognizes models that appear in `litert-lm list` (i.e. that
 * have gone through `litert-lm import <file> <alias>`), and selects between
 * them per-request via the JSON body's `model` field set to that alias -
 * see `ModelCatalogEntry.alias` and scratchpad/sidecar-verification.md §2/§3.
 * `litert-lm import` on a local file is just `shutil.copy(source, dest)`
 * under the hood (confirmed by reading the installed
 * `litert_lm_cli/commands/import.py`) into
 * `$LITERT_LM_DIR/models/<alias>/model.litertlm` (`$LITERT_LM_DIR` defaults
 * to `~/.litert-lm` but is fully overridable via that env var - also
 * confirmed by reading `litert_lm_cli/model.py::get_cli_base_dir`). Rather
 * than reimplementing that copy ourselves (and risking drifting from
 * whatever `import` does in a future litert-lm release), this class shells
 * out to the real `litert-lm import` CLI after every successful download,
 * with `LITERT_LM_DIR` pointed at a directory under our own `userData` (so
 * we never touch the user's real `~/.litert-lm`), and the same directory is
 * exported for `Sidecar` to pass through when it spawns `litert-lm serve` -
 * see `BackendController.rebuild()`.
 */
export class ModelManager extends EventEmitter {
  private readonly modelsDir: string
  private readonly litertLmDir: string
  private readonly progress = new Map<ModelId, ModelDownloadProgress>()
  private readonly abortControllers = new Map<ModelId, AbortController>()

  constructor(userDataDir: string) {
    super()
    this.modelsDir = join(userDataDir, 'models')
    this.litertLmDir = join(userDataDir, 'litert-lm-home')
    mkdirSync(this.modelsDir, { recursive: true })
  }

  private finalPath(modelId: ModelId): string {
    return join(this.modelsDir, `${modelId}.litertlm`)
  }

  private partPath(modelId: ModelId): string {
    return join(this.modelsDir, `${modelId}.litertlm.part`)
  }

  getInstalledModelPath(modelId: ModelId): string | null {
    const path = this.finalPath(modelId)
    return existsSync(path) ? path : null
  }

  /** The `LITERT_LM_DIR` this ModelManager imports models into - pass this through as an env var to any spawned `litert-lm` process (import or serve) so they agree on where models live. */
  getLitertLmDir(): string {
    return this.litertLmDir
  }

  private importedModelPath(modelId: ModelId): string {
    const alias = getCatalogEntry(modelId).alias
    return join(this.litertLmDir, 'models', alias, 'model.litertlm')
  }

  /** Whether `modelId` has already been `litert-lm import`-ed into our sandboxed LITERT_LM_DIR (i.e. `litert-lm list` against that dir would show its alias). */
  isImported(modelId: ModelId): boolean {
    return existsSync(this.importedModelPath(modelId))
  }

  /**
   * Runs `<cliBinary> import <downloadedFile> <alias>` (see class doc) so the
   * sidecar can find this model by alias. No-ops if already imported. Safe
   * to call even if the underlying file hasn't changed - `import` just
   * re-copies it.
   */
  async importModel(modelId: ModelId, cliBinary: string): Promise<void> {
    const filePath = this.finalPath(modelId)
    if (!existsSync(filePath)) {
      throw new Error(`Cannot import ${modelId}: ${filePath} does not exist (download it first).`)
    }
    const alias = getCatalogEntry(modelId).alias

    await new Promise<void>((resolve, reject) => {
      const child = spawn(cliBinary, ['import', filePath, alias], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, LITERT_LM_DIR: this.litertLmDir }
      })
      let stderr = ''
      child.stdout?.on('data', () => {})
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf-8')
      })
      child.on('error', (err) => {
        reject(new Error(`Failed to run '${cliBinary} import': ${err.message}`))
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else
          reject(
            new Error(
              `'${cliBinary} import ${filePath} ${alias}' exited with code ${code}${
                stderr ? `: ${stderr.trim().slice(0, 500)}` : ''
              }`
            )
          )
      })
    })
  }

  listInstalled(): InstalledModelInfo[] {
    return MODEL_CATALOG.filter((entry) => existsSync(this.finalPath(entry.id))).map((entry) => ({
      modelId: entry.id,
      filePath: this.finalPath(entry.id),
      sizeBytes: statSync(this.finalPath(entry.id)).size
    }))
  }

  getProgress(modelId: ModelId): ModelDownloadProgress {
    const tracked = this.progress.get(modelId)
    if (tracked) return tracked
    const installed = existsSync(this.finalPath(modelId))
    return {
      modelId,
      state: installed ? 'done' : 'idle',
      receivedBytes: 0,
      totalBytes: installed ? statSync(this.finalPath(modelId)).size : null
    }
  }

  getAllProgress(): ModelDownloadProgress[] {
    return MODEL_CATALOG.map((entry) => this.getProgress(entry.id))
  }

  /** Resolves the repo's actual `.litertlm` filename via the HF API, then HEADs it for a byte-accurate size. */
  private async resolveDownloadTarget(
    modelId: ModelId
  ): Promise<{ url: string; totalBytes: number | null }> {
    const entry = getCatalogEntry(modelId)
    const apiUrl = `https://huggingface.co/api/models/${entry.repo}`
    const res = await fetch(apiUrl)
    if (!res.ok) {
      throw new Error(`Failed to look up ${entry.repo} on HuggingFace (HTTP ${res.status})`)
    }
    const info = (await res.json()) as HfModelInfo
    const file = (info.siblings ?? []).find(
      (s) => s.rfilename.endsWith('.litertlm') && !s.rfilename.includes('-web')
    )
    if (!file) {
      throw new Error(`No .litertlm file found in HuggingFace repo ${entry.repo}`)
    }
    const url = `https://huggingface.co/${entry.repo}/resolve/main/${file.rfilename}`

    let totalBytes: number | null = null
    try {
      const head = await fetch(url, { method: 'HEAD', redirect: 'follow' })
      const len = head.headers.get('content-length')
      if (len) totalBytes = Number(len)
    } catch {
      // Non-fatal - progress just won't have a known total until bytes arrive.
    }
    return { url, totalBytes }
  }

  /**
   * Starts (or resumes, via HTTP Range, if a .part file already exists) a
   * download, then registers the result with `litert-lm import` (see class
   * doc) so it's immediately usable by a managed sidecar - the Settings
   * screen's single "Download" button covers both steps, surfaced as the
   * 'downloading' -> 'importing' -> 'done' progression. `cliBinary` is the
   * `litert-lm` executable to run for the import step (defaults to the
   * bare command, resolved via PATH) - pass the same binary your managed
   * sidecar command uses so the import lands somewhere `serve` will find it.
   * Progress is emitted via 'progress'.
   */
  async download(modelId: ModelId, cliBinary = 'litert-lm'): Promise<void> {
    if (this.getProgress(modelId).state === 'downloading') return

    log.info(`model: download start ${modelId}`)
    this.setProgress({ modelId, state: 'resolving', receivedBytes: 0, totalBytes: null })
    const controller = new AbortController()
    this.abortControllers.set(modelId, controller)

    const partPath = this.partPath(modelId)

    try {
      const { url, totalBytes } = await this.resolveDownloadTarget(modelId)

      let startByte = existsSync(partPath) ? statSync(partPath).size : 0
      this.setProgress({ modelId, state: 'downloading', receivedBytes: startByte, totalBytes })

      const headers: Record<string, string> = {}
      if (startByte > 0) headers.Range = `bytes=${startByte}-`

      const res = await fetch(url, { headers, signal: controller.signal })
      if (!res.ok && res.status !== 206) {
        throw new Error(`Download failed (HTTP ${res.status})`)
      }
      if (startByte > 0 && res.status !== 206) {
        // Server didn't honor the Range request - restart clean rather than
        // silently corrupt/duplicate the file.
        startByte = 0
        if (existsSync(partPath)) unlinkSync(partPath)
      }
      if (!res.body) {
        throw new Error('Sidecar download response had no body')
      }

      const fileStream = createWriteStream(partPath, { flags: startByte > 0 ? 'a' : 'w' })
      const reader = res.body.getReader()
      let received = startByte

      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        if (value && value.length > 0) {
          await writeChunk(fileStream, Buffer.from(value))
          received += value.length
          this.setProgress({ modelId, state: 'downloading', receivedBytes: received, totalBytes })
        }
      }
      await closeStream(fileStream)

      const finalPath = this.finalPath(modelId)
      if (existsSync(finalPath)) unlinkSync(finalPath)
      renameSync(partPath, finalPath)

      this.setProgress({ modelId, state: 'importing', receivedBytes: received, totalBytes })
      try {
        await this.importModel(modelId, cliBinary)
      } catch (importErr) {
        throw new Error(
          `Downloaded but failed to register with litert-lm: ${
            importErr instanceof Error ? importErr.message : String(importErr)
          }`
        )
      }

      this.setProgress({
        modelId,
        state: 'done',
        receivedBytes: received,
        totalBytes: totalBytes ?? received
      })
      log.info(`model: download+import done ${modelId}`)
    } catch (err) {
      const prior = this.progress.get(modelId)
      if (controller.signal.aborted) {
        log.warn(`model: download cancelled ${modelId}`)
        this.setProgress({
          modelId,
          state: 'cancelled',
          receivedBytes: prior?.receivedBytes ?? 0,
          totalBytes: prior?.totalBytes ?? null
        })
      } else {
        const message = err instanceof Error ? err.message : String(err)
        log.error(`model: download failed ${modelId}: ${message}`)
        this.setProgress({
          modelId,
          state: 'error',
          receivedBytes: prior?.receivedBytes ?? 0,
          totalBytes: prior?.totalBytes ?? null,
          error: message
        })
      }
    } finally {
      this.abortControllers.delete(modelId)
    }
  }

  cancelDownload(modelId: ModelId): void {
    this.abortControllers.get(modelId)?.abort()
  }

  /** Deletes the installed model (and any stale partial download). */
  remove(modelId: ModelId): void {
    this.cancelDownload(modelId)
    const finalPath = this.finalPath(modelId)
    if (existsSync(finalPath)) unlinkSync(finalPath)
    const partPath = this.partPath(modelId)
    if (existsSync(partPath)) unlinkSync(partPath)
    this.setProgress({ modelId, state: 'idle', receivedBytes: 0, totalBytes: null })
  }

  private setProgress(progress: ModelDownloadProgress): void {
    this.progress.set(progress.modelId, progress)
    this.emit('progress', progress)
  }
}

// Re-exported for convenience so callers don't need a separate import from shared/models.
export type { ModelDownloadState }
