import { execFile, type ExecFileOptions } from 'child_process'
import type { PasteOutcome } from '../shared/types'
import { log } from './log'

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

/**
 * Full argv for the `powershell` invocation, including `-WindowStyle Hidden`.
 * This alone does NOT stop the initial conhost window flash/focus-steal -
 * `-WindowStyle Hidden` only affects the PowerShell host window itself,
 * decided *after* Windows has already created (and, without a GUI-subsystem
 * parent process, activated) a console for the child process. The real fix
 * is the `windowsHide: true` spawn option (see getInjectPasteExecOptions),
 * which asks Windows not to create that console window in the first place.
 * Both are applied together as defense in depth - see PASTE_SETTLE_MS doc
 * comment and the module-level bug this fixes: releasing the push-to-talk
 * key was stealing OS focus away from the target app at the exact moment
 * Ctrl+V needed to land, because the console window Node spawned for
 * `powershell` (with no windowsHide option previously) took foreground.
 */
export function buildWindowsSendKeysArgs(): string[] {
  return [
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle',
    'Hidden',
    '-Command',
    buildWindowsSendKeysCommand()
  ]
}

/**
 * `windowsHide: true` is the load-bearing part (see buildWindowsSendKeysArgs
 * doc comment) - it's a no-op on non-Windows platforms, so it's returned
 * unconditionally rather than gated, but only matters for win32's
 * `powershell` invocation.
 */
export function getInjectPasteExecOptions(): ExecFileOptions {
  return { windowsHide: true }
}

/** --clearmodifiers so a still-physically-held modifier key doesn't get folded into the synthesized combo. */
export function buildLinuxXdotoolArgs(): string[] {
  return ['key', '--clearmodifiers', 'ctrl+v']
}

// --- xdotool availability probe (checked once, cached) -----------------------------------------

let xdotoolAvailableCache: Promise<boolean> | null = null

function execFileAsync(
  command: string,
  args: string[],
  options: ExecFileOptions = {}
): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, options, (error) => {
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

// --- Paste injection dispatch ------------------------------------------------------------------

/**
 * Attempts the injection directly - no pre-probing (e.g. checking xdotool is
 * on PATH first) to decide behavior ahead of time. If it's missing/fails,
 * the command just fails and that's what gets logged and reported; this
 * function is never used to silently change what the caller does.
 */
async function injectPasteReal(): Promise<void> {
  if (process.platform === 'win32') {
    await execFileAsync('powershell', buildWindowsSendKeysArgs(), getInjectPasteExecOptions())
    return
  }
  if (process.platform === 'linux') {
    await execFileAsync('xdotool', buildLinuxXdotoolArgs())
    return
  }
  throw new Error(`Unsupported platform for paste injection: ${process.platform}`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Describes the injection command actually attempted, for logging - see copyAndPaste. */
function describeInjectCommand(): string {
  if (process.platform === 'win32')
    return 'powershell -WindowStyle Hidden -Command SendKeys(^v) (windowsHide)'
  if (process.platform === 'linux') return `xdotool ${buildLinuxXdotoolArgs().join(' ')}`
  return `unsupported platform: ${process.platform}`
}

/**
 * Always copies `text` to the clipboard - that's the feature, and it always
 * happens first regardless of what follows. If `autoPasteEnabled`, waits
 * `PASTE_SETTLE_MS` (see doc comment above) then attempts to simulate
 * Ctrl+V into whatever window currently has OS focus - which, because the
 * overlay window is never focusable and shown via `showInactive()` (see
 * overlay.ts), should still be whatever app the user was dictating into. If
 * that injection attempt fails, this is reported as a real failure (not
 * silently downgraded to a "clipboard-only" success) - the text is still on
 * the clipboard, but auto-paste itself did not work.
 */
export async function copyAndPaste(
  clipboard: ClipboardLike,
  text: string,
  autoPasteEnabled: boolean,
  injectPaste: () => Promise<void> = injectPasteReal
): Promise<PasteOutcome> {
  if (!text) {
    // Deliberately does NOT write the empty string first - that would wipe
    // whatever the user already had on their clipboard as the reward for a
    // dictation that produced nothing.
    return { copied: false, pasted: false, message: 'Nothing to copy.' }
  }
  clipboard.writeText(text)
  if (!autoPasteEnabled) {
    return { copied: true, pasted: false, message: 'Copied. Press Ctrl+V to paste.' }
  }
  await delay(PASTE_SETTLE_MS)
  const command = describeInjectCommand()
  try {
    await injectPaste()
    log.info(`paste: ok (${command})`)
    return { copied: true, pasted: true, message: 'Copied and pasted.' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    log.error(`paste: failed (${command}): ${reason}`)
    return {
      copied: true,
      pasted: false,
      message: 'Paste failed. The text is on your clipboard.'
    }
  }
}
