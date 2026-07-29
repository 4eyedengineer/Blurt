/**
 * Model catalog + download-manager types, shared between the main-process
 * `ModelManager` (src/main/backend/modelManager.ts) and the renderer's
 * Settings screen. The actual `.litertlm` filename inside each HuggingFace
 * repo is NOT hardcoded here - it's resolved at download time via the HF
 * API, since repo maintainers can rename files across releases. What *is*
 * stable enough to hardcode is which repo backs each `ModelId` and a rough
 * size estimate for the download-size hint shown before a download starts.
 */
import type { ModelId } from './types'

export interface ModelCatalogEntry {
  id: ModelId
  label: string
  /** ungated HuggingFace repo id, e.g. "litert-community/gemma-4-E2B-it-litert-lm". */
  repo: string
  /**
   * The model ID `litert-lm import <file> <alias>` registers this model
   * under, and therefore the exact string that must be sent as the `model`
   * field on every `/v1/chat/completions` request (verified empirically
   * against a real `litert-lm serve` - see scratchpad/sidecar-verification.md
   * §2/§4a). This is NOT the same as our internal `ModelId` - the server has
   * no idea what "gemma-4-e2b" means, only whatever alias it was imported
   * as.
   */
  alias: string
  /** Rough download size, for UI display before the real size is resolved. */
  approxSizeBytes: number
}

export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    id: 'gemma-4-e2b',
    label: 'Gemma 4 E2B',
    repo: 'litert-community/gemma-4-E2B-it-litert-lm',
    alias: 'e2b',
    approxSizeBytes: 2_588_147_712
  },
  {
    id: 'gemma-4-e4b',
    label: 'Gemma 4 E4B',
    repo: 'litert-community/gemma-4-E4B-it-litert-lm',
    alias: 'e4b',
    approxSizeBytes: 3_659_530_240
  },
  {
    id: 'gemma-4-12b',
    label: 'Gemma 4 12B',
    repo: 'litert-community/gemma-4-12B-it-litert-lm',
    alias: '12b',
    approxSizeBytes: 6_547_589_312
  }
]

export function getCatalogEntry(id: ModelId): ModelCatalogEntry {
  const entry = MODEL_CATALOG.find((m) => m.id === id)
  if (!entry) throw new Error(`Unknown model id: ${id}`)
  return entry
}

export type ModelDownloadState =
  'idle' | 'resolving' | 'downloading' | 'importing' | 'done' | 'error' | 'cancelled'

export interface ModelDownloadProgress {
  modelId: ModelId
  state: ModelDownloadState
  /** Bytes received so far (this download attempt; resumes start back at 0 today - see modelManager.ts). */
  receivedBytes: number
  /** Total bytes if known (resolved from the HF API or the response's Content-Length). */
  totalBytes: number | null
  error?: string
}

export interface InstalledModelInfo {
  modelId: ModelId
  filePath: string
  sizeBytes: number
}
