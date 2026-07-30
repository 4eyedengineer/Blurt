import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Tiny structured logger for the main process. Appends one-line, greppable
 * entries to `userData/logs/main.log`; truncates the file once it exceeds
 * MAX_BYTES rather than growing forever. Mirrors to console in dev so
 * `npm run dev` output still shows everything.
 *
 * Must call `initLog` once (in src/main/index.ts) before any log line is
 * expected to reach disk - calls made before that only reach console (dev)
 * or nowhere (prod), which is fine since nothing logs that early.
 */
const MAX_BYTES = 5 * 1024 * 1024

let logFile: string | null = null
let mirrorToConsole = false

export function initLog(userDataDir: string, dev: boolean): void {
  const dir = join(userDataDir, 'logs')
  mkdirSync(dir, { recursive: true })
  logFile = join(dir, 'main.log')
  mirrorToConsole = dev
}

export function getLogsDir(userDataDir: string): string {
  return join(userDataDir, 'logs')
}

function rotateIfNeeded(): void {
  if (!logFile) return
  try {
    if (existsSync(logFile) && statSync(logFile).size > MAX_BYTES) {
      writeFileSync(logFile, '')
    }
  } catch {
    // Best-effort rotation only - a failure here must not block logging.
  }
}

function write(level: 'info' | 'warn' | 'error', line: string): void {
  const full = `${new Date().toISOString()} [${level}] ${line}`
  if (mirrorToConsole || !logFile) console.log(full)
  if (!logFile) return
  rotateIfNeeded()
  try {
    appendFileSync(logFile, full + '\n')
  } catch {
    // Disk full/permission error - nothing more this logger can do.
  }
}

export const log = {
  info: (line: string): void => write('info', line),
  warn: (line: string): void => write('warn', line),
  error: (line: string): void => write('error', line)
}
