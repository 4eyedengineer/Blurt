import { globalShortcut } from 'electron'
import { log } from './log'

/**
 * (Re-)registers the single global shortcut this app uses to toggle
 * dictation from anywhere in Windows. Always unregisters everything first
 * so changing the hotkey in Settings can't leave a stale binding behind.
 */
export function applyGlobalShortcut(accelerator: string, onTrigger: () => void): boolean {
  globalShortcut.unregisterAll()
  try {
    const ok = globalShortcut.register(accelerator, onTrigger)
    if (!ok) {
      log.error(`hotkey: failed to register "${accelerator}" (already in use by another app?)`)
    }
    return ok
  } catch (err) {
    log.error(
      `hotkey: error registering "${accelerator}": ` +
        `${err instanceof Error ? err.message : String(err)}`
    )
    return false
  }
}
