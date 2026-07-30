import { useEffect, useState } from 'react'
import type { BackendStatus } from '@shared/backend'

const INITIAL_STATUS: BackendStatus = { state: 'starting' }

/** Tracks the main process's current InferenceBackend connectivity state, for the header status pill. */
export function useBackendStatus(): BackendStatus {
  const [status, setStatus] = useState<BackendStatus>(INITIAL_STATUS)

  useEffect(() => {
    let cancelled = false
    window.api.dictation.getStatus().then((initial) => {
      if (!cancelled) setStatus(initial)
    })
    const unsubscribe = window.api.dictation.onStatusChanged((next) => setStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return status
}
