import { useCallback, useEffect, useState } from 'react'
import type { ModelId } from '@shared/types'
import type { InstalledModelInfo, ModelDownloadProgress } from '@shared/models'
import { MODEL_CATALOG } from '@shared/models'

export interface UseModelManager {
  installed: InstalledModelInfo[]
  progress: Record<ModelId, ModelDownloadProgress>
  download: (modelId: ModelId) => void
  cancelDownload: (modelId: ModelId) => void
  remove: (modelId: ModelId) => void
}

function defaultProgress(): Record<ModelId, ModelDownloadProgress> {
  const entries = MODEL_CATALOG.map(
    (m) => [m.id, { modelId: m.id, state: 'idle', receivedBytes: 0, totalBytes: null }] as const
  )
  return Object.fromEntries(entries) as Record<ModelId, ModelDownloadProgress>
}

/** Drives the Settings screen's model download UI: installed-model list + live per-model download progress. */
export function useModelManager(): UseModelManager {
  const [installed, setInstalled] = useState<InstalledModelInfo[]>([])
  const [progress, setProgress] =
    useState<Record<ModelId, ModelDownloadProgress>>(defaultProgress())

  const refresh = useCallback(() => {
    window.api.models.list().then(({ installed: installedList, progress: progressList }) => {
      setInstalled(installedList)
      setProgress((prev) => {
        const next = { ...prev }
        for (const p of progressList) next[p.modelId] = p
        return next
      })
    })
  }, [])

  useEffect(() => {
    refresh()
    const unsubscribe = window.api.models.onProgress((p) => {
      setProgress((prev) => ({ ...prev, [p.modelId]: p }))
      if (p.state === 'done' || p.state === 'idle') refresh()
    })
    return unsubscribe
  }, [refresh])

  const download = useCallback((modelId: ModelId) => {
    void window.api.models.download(modelId)
  }, [])

  const cancelDownload = useCallback((modelId: ModelId) => {
    void window.api.models.cancelDownload(modelId)
  }, [])

  const remove = useCallback(
    (modelId: ModelId) => {
      void window.api.models.remove(modelId).then(refresh)
    },
    [refresh]
  )

  return { installed, progress, download, cancelDownload, remove }
}
