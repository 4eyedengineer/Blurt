import { execFile } from 'child_process'
import type { PasteOutcome } from '../shared/types'

/** clipboard.writeText is the only bit of Electron's `clipboard` module this file needs - typed narrowly so tests can inject a fake. */
export interface ClipboardLike {
  writeText(text: string): void
}

export type { PasteOutcome }

/** Gives the physical key release (uiohook's keyup) time to fully settle before injecting Ctrl+V - see module doc comment. */
export const PASTE_SETTLE_MS = 150

// --- Pure command/argument builders (unit-tested; the actual process spawn is not) ------------

/**
 * The user is very likely still releasing (or just released) the
 * push-to-talk key when this runs - if that key were Alt or Ctrl, sending
 * Ctrl+V while it's still logically "down" would be received by the
 * target app as Ctrl+Alt+V or Ctrl+Ctrl+V. `PASTE_SETTLE_MS` plus (on
 * Windows) `SendKeys` sending literal `^v` from a fresh process, and (on
 * Linux) `xdotool --clearmodifiers`, are both mitigations for this - see
 * requirement 4 in the feature spec this file implements.
 */
export function buildWindowsSendKeysCommand(): string {
  return "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"
}

export function buildMacPasteScript(): string {
  return 'tell application "System Events" to keystroke "v" using command down'
}

/** --clearmodifiers so a still-physically-held modifier key doesn't get folded into the synthesized combo. */
export function buildLinuxXdotoolArgs(): string[] {
  return ['key', '--clearmodifiers', 'ctrl+v']
}

// --- xdotool availability probe (checked once, cached) -----------------------------------------

let xdotoolAvailableCache: Promise<boolean> | null = null

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) reject(error)
      else resolve()
    })
  })
}

/** Probes for `xdotool` on PATH once and caches the (resolved) result for the process lifetime. */
export function checkXdotoolAvailable(): Promise<boolean> {
  if (!xdotoolAvailableCache) {
    xdotoolAvailableCache = execFileAsync('which', ['xdotool']).then(
      () => true,
      () => false
    )
  }
  return xdotoolAvailableCache
}

/** Test-only hook to reset the memoized probe between cases. */
export function resetXdotoolAvailableCacheForTests(): void {
  xdotoolAvailableCache = null
}

// --- Paste injection dispatch ------------------------------------------------------------------

async function injectPasteReal(): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('powershell', ['-NoProfile', '-Command', buildWindowsSendKeysCommand()])
    return
  }
  if (process.platform === 'darwin') {
    await execFileAsync('osascript', ['-e', buildMacPasteScript()])
    return
  }
  if (process.platform === 'linux') {
    const available = await checkXdotoolAvailable()
    if (!available) throw new Error('xdotool not found on PATH')
    await execFileAsync('xdotool', buildLinuxXdotoolArgs())
    return
  }
  throw new Error(`Unsupported platform for paste injection: ${process.platform}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Always copies `text` to the clipboard. If `autoPasteEnabled`, waits
 * `PASTE_SETTLE_MS` (see doc comment above) then attempts to simulate
 * Ctrl+V into whatever window currently has OS focus - which, because the
 * overlay window is never focusable and shown via `showInactive()` (see
 * overlay.ts), should still be whatever app the user was dictating into.
 * Falls back to a clipboard-only outcome (with an explanatory message) if
 * auto-paste is off, unsupported on this platform, or the injection attempt
 * itself fails for any reason (e.g. xdotool missing).
 */
export async function copyAndPaste(
  clipboard: ClipboardLike,
  text: string,
  autoPasteEnabled: boolean,
  injectPaste: () => Promise<void> = injectPasteReal
): Promise<PasteOutcome> {
  clipboard.writeText(text)
  if (!text) {
    return { copied: false, pasted: false, message: 'Nothing to copy.' }
  }
  if (!autoPasteEnabled) {
    return { copied: true, pasted: false, message: 'Copied — press Ctrl+V to paste.' }
  }
  await delay(PASTE_SETTLE_MS)
  try {
    await injectPaste()
    return { copied: true, pasted: true, message: 'Copied and pasted.' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return {
      copied: true,
      pasted: false,
      message: `Copied — press Ctrl+V to paste (auto-paste unavailable: ${reason}).`
    }
  }
}
