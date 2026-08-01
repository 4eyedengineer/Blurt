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
 * requirement 4 in the feature spec this file implements. macOS has no
 * equivalent mitigation: System Events' `keystroke ... using command down`
 * (see buildMacosOsascriptArgs) has no flag analogous to
 * `--clearmodifiers` that strips a still-physically-held modifier out of
 * the synthesized combo, so on darwin `PASTE_SETTLE_MS` alone carries the
 * weight that Windows and Linux split across two mechanisms. This is a real
 * gap, not a solved problem - it's called out here rather than implied to
 * have parity with the other two branches.
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

/**
 * macOS pastes with Cmd+V, not Ctrl+V. `osascript` driving System Events'
 * `keystroke` command is the standard way to synthesize that from outside
 * the target app. This has NOT been verified on real macOS hardware -
 * nobody on this project has a Mac to run it on yet - so treat the argv
 * shape as "should work per documented osascript/System Events behavior,"
 * not as observed fact. See the buildWindowsSendKeysCommand doc comment
 * above for why that matters more here than on the other two platforms:
 * there is no --clearmodifiers-equivalent flag for System Events, so
 * PASTE_SETTLE_MS is doing more of the work on darwin.
 */
export function buildMacosOsascriptArgs(): string[] {
  return ['-e', 'tell application "System Events" to keystroke "v" using command down']
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
  if (process.platform === 'darwin') {
    await execFileAsync('osascript', buildMacosOsascriptArgs())
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
  if (process.platform === 'darwin') return `osascript ${buildMacosOsascriptArgs().join(' ')}`
  return `unsupported platform: ${process.platform}`
}

const ASSISTIVE_ACCESS_SIGNATURE = /assistive access/i
const ASSISTIVE_ACCESS_ERROR_CODE = '-1719'

/** The one macOS failure a user can actually act on - see describePasteFailure. */
const MACOS_ACCESSIBILITY_MESSAGE =
  'Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & ' +
  'Security > Accessibility - the text is on your clipboard.'

/**
 * Turns a raw injection-failure reason into the string shown to the user.
 * Every reason on every platform keeps the existing generic wording
 * UNCHANGED, with exactly one diagnosable exception: on darwin,
 * synthesizing a keystroke via System Events requires the app to hold the
 * Accessibility (TCC) permission, and without it `osascript` fails with a
 * message documented (by Apple, and widely reported by other tools that
 * script System Events) to contain "...is not allowed assistive access."
 * alongside error code -1719. That's the one failure mode here a user can
 * actually fix, so it gets a distinct, actionable message instead of the
 * generic "clipboard-only" one - see the module doc comment for why a
 * failure is never silently downgraded to a success.
 *
 * This has NOT been verified against a real unpermissioned run on macOS
 * hardware - nobody on this project has a Mac to test it on yet - so the
 * match is deliberately loose (case-insensitive substring on "assistive
 * access", OR the bare "-1719" code, rather than a single exact string) to
 * tolerate wording drift across macOS versions. Anything that doesn't match
 * still falls through to the same honest generic message every other
 * platform/reason gets, so a missed match fails safe rather than hiding a
 * real error.
 *
 * Takes `platform` as an explicit parameter (rather than reading
 * `process.platform` itself) so it stays a pure function - `process.platform`
 * can't be reassigned in a test without a defineProperty-based helper, and
 * this way its unit tests don't need one.
 */
export function describePasteFailure(platform: NodeJS.Platform, reason: string): string {
  const isMacosAccessibilityFailure =
    platform === 'darwin' &&
    (ASSISTIVE_ACCESS_SIGNATURE.test(reason) || reason.includes(ASSISTIVE_ACCESS_ERROR_CODE))
  if (isMacosAccessibilityFailure) {
    return MACOS_ACCESSIBILITY_MESSAGE
  }
  return 'Paste failed. The text is on your clipboard.'
}

/**
 * Always copies `text` to the clipboard - that's the feature, and it always
 * happens first regardless of what follows. If `autoPasteEnabled`, waits
 * `PASTE_SETTLE_MS` (see doc comment above) then attempts to simulate the
 * platform's paste keystroke (Ctrl+V on win32/linux, Cmd+V on darwin) into
 * whatever window currently has OS focus - which, because the overlay
 * window is never focusable and shown via `showInactive()` (see
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
      message: describePasteFailure(process.platform, reason)
    }
  }
}
