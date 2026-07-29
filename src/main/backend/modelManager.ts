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
import { EventEmitter } from 'events'
import type { ModelId } from '../../shared/types'
import {
  MODEL_CATALOG,
  getCatalogEntry,
  type InstalledModelInfo,
  type ModelDownloadProgress,
  type ModelDownloadState
} from '../../shared/models'

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
 */
export class ModelManager extends EventEmitter {
  private readonly modelsDir: string
  private readonly progress = new Map<ModelId, ModelDownloadProgress>()
  private readonly abortControllers = new Map<ModelId, AbortController>()

  constructor(userDataDir: string) {
    super()
    this.modelsDir = join(userDataDir, 'models')
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

  /** Starts (or resumes, via HTTP Range, if a .part file already exists) a download. Progress is emitted via 'progress'. */
  async download(modelId: ModelId): Promise<void> {
    if (this.getProgress(modelId).state === 'downloading') return

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

      this.setProgress({
        modelId,
        state: 'done',
        receivedBytes: received,
        totalBytes: totalBytes ?? received
      })
    } catch (err) {
      const prior = this.progress.get(modelId)
      if (controller.signal.aborted) {
        this.setProgress({
          modelId,
          state: 'cancelled',
          receivedBytes: prior?.receivedBytes ?? 0,
          totalBytes: prior?.totalBytes ?? null
        })
      } else {
        this.setProgress({
          modelId,
          state: 'error',
          receivedBytes: prior?.receivedBytes ?? 0,
          totalBytes: prior?.totalBytes ?? null,
          error: err instanceof Error ? err.message : String(err)
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
