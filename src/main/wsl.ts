import { readFileSync } from 'fs'

/** Pure check on an already-read /proc/version string - see detectWSL. */
export function isWSLVersionString(versionString: string): boolean {
  return /microsoft/i.test(versionString)
}

/**
 * Detects whether we're running under WSL (any version) - used to explain,
 * in Settings, why the system-wide push-to-talk overlay is limited there:
 * the X11 key hook (and xdotool paste injection) only see X11/WSLg-hosted
 * windows, not native Windows applications - see README "Running under
 * WSLg" / "Known limitations".
 */
export function detectWSL(
  platform: NodeJS.Platform,
  readProcVersion: () => string = () => readFileSync('/proc/version', 'utf8')
): boolean {
  if (platform !== 'linux') return false
  try {
    return isWSLVersionString(readProcVersion())
  } catch {
    return false
  }
}

export function detectWSLReal(): boolean {
  return detectWSL(process.platform)
}
