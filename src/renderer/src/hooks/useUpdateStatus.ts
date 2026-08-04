import { useEffect, useState } from 'react'
import type { UpdateStatus } from '@shared/updater'

/**
 * Opens on 'checking' rather than 'idle' for the same reason
 * UpdateController does: 'idle' renders as "Blurt is up to date", and that
 * would be a claim made before the first status has even arrived.
 */
const INITIAL_STATUS: UpdateStatus = { state: 'checking' }

/** Tracks the main process's self-update state, for the Settings screen's Updates row. */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>(INITIAL_STATUS)

  useEffect(() => {
    let cancelled = false
    window.api.update.getStatus().then((initial) => {
      if (!cancelled) setStatus(initial)
    })
    const unsubscribe = window.api.update.onStatusChanged((next) => setStatus(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [])

  return status
}
