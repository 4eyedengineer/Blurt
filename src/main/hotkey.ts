import { globalShortcut } from 'electron'

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
      console.error(
        `[hotkey] Failed to register "${accelerator}" (already in use by another app?).`
      )
    }
    return ok
  } catch (err) {
    console.error(`[hotkey] Error registering "${accelerator}".`, err)
    return false
  }
}
