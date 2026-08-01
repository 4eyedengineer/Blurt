import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs'
import { spawnSync } from 'child_process'
import * as net from 'net'
import { log } from '../log'

/**
 * Port/process lifecycle hygiene for a *managed* sidecar - the fix for a
 * real, observed bug: the Electron app spawned its own `python
 * serve_gpu.py serve ...` sidecar, but the readiness check (`GET
 * /v1/models`) was answered by a *different*, unrelated process that
 * happened to already be listening on the same port (a leftover sidecar
 * from a previous run of this same app) - so the app reported "Ready" in
 * 64ms (impossible for a real eager GPU engine load, which takes 8-15s)
 * while its own freshly-spawned child was still loading (or had failed)
 * in the background, unobserved. Confirmed on a real Windows host: a
 * stale WSL-side `litert-lm serve` process, exposed on the Windows loopback
 * via WSL2's automatic localhost-forwarding relay (`wslrelay.exe`), was
 * answering `127.0.0.1:9379` for the Windows app's own managed sidecar.
 *
 * Two independent mechanisms, applied in this order before every managed
 * spawn:
 *
 * 1. **Our own mess**: a small JSON pid-file (`userData/sidecar.pid`,
 *    `SidecarPidRecord`) records the pid/port/start-time of the last
 *    managed child *we* spawned. If that pid is still alive and its
 *    cmdline still looks like a sidecar we'd spawn (`serve_gpu.py`, or a
 *    plain `litert-lm ... serve`), it's almost certainly a leftover from a
 *    crashed/killed previous run (e.g. this same Electron app didn't
 *    shut down cleanly) - killed and logged. Deliberately does NOT trust
 *    the recorded pid blindly: PIDs get recycled by the OS, so the cmdline
 *    check guards against killing an unrelated process that happens to
 *    reuse that number.
 * 2. **Someone else's mess**: if the port is *still* occupied after that
 *    (or was never ours to begin with), this refuses to spawn at all and
 *    surfaces a hard error naming the offending PID(s) - deliberately NOT
 *    "try to spawn anyway and hope for the best" or "trust whatever
 *    answers the port", which is exactly the bug above. No silent
 *    fallbacks - per this project's philosophy, an unidentified process
 *    answering our port is never treated as "our sidecar is ready".
 */

export interface SidecarPidRecord {
  pid: number
  port: number
  startedAt: string
}

/** Parses `userData/sidecar.pid`'s content. Returns null for anything malformed rather than throwing - a corrupt/partial pid file must never crash startup, just be treated as "nothing recorded". */
export function parsePidFileContent(content: string): SidecarPidRecord | null {
  try {
    const obj: unknown = JSON.parse(content)
    if (
      obj !== null &&
      typeof obj === 'object' &&
      Number.isInteger((obj as Record<string, unknown>).pid) &&
      ((obj as Record<string, unknown>).pid as number) > 0 &&
      Number.isInteger((obj as Record<string, unknown>).port) &&
      ((obj as Record<string, unknown>).port as number) > 0 &&
      typeof (obj as Record<string, unknown>).startedAt === 'string'
    ) {
      const rec = obj as SidecarPidRecord
      return { pid: rec.pid, port: rec.port, startedAt: rec.startedAt }
    }
    return null
  } catch {
    return null
  }
}

export function serializePidRecord(record: SidecarPidRecord): string {
  return JSON.stringify(record)
}

/**
 * Whether a process's cmdline looks like one of our own managed sidecar
 * spawns - either the GPU wrapper (`serve_gpu.py`) or a plain `litert-lm
 * ... serve` invocation (what an external/custom command looks like). Used to
 * avoid killing an unrelated process that happens to have reused a
 * recycled PID recorded in a stale pid-file - see this module's doc
 * comment.
 */
export function matchesSidecarSignature(cmdline: string): boolean {
  if (/serve_gpu\.py/i.test(cmdline)) return true
  return /litert-lm(\.exe)?\b/i.test(cmdline) && /\bserve\b/i.test(cmdline)
}

export type StalePidDecision =
  { action: 'kill'; reason: string } | { action: 'ignore'; reason: string }

/**
 * Pure decision for what to do about a previously-recorded pid file, given
 * facts already gathered about it (liveness, cmdline). Deterministic:
 * kill only when the recorded pid is both alive AND its cmdline matches
 * our own sidecar signature; anything else (no record, not alive, cmdline
 * unreadable, cmdline doesn't match) is left alone rather than guessed at.
 */
export function decideStalePidAction(params: {
  record: SidecarPidRecord | null
  isAlive: boolean
  cmdline: string | null
}): StalePidDecision {
  const { record, isAlive, cmdline } = params
  if (!record) return { action: 'ignore', reason: 'no sidecar pid file recorded' }
  if (!isAlive) {
    return { action: 'ignore', reason: `recorded pid ${record.pid} is no longer alive` }
  }
  if (cmdline === null) {
    return {
      action: 'ignore',
      reason: `recorded pid ${record.pid} is alive but its command line couldn't be read - refusing to guess whether it's ours`
    }
  }
  if (!matchesSidecarSignature(cmdline)) {
    return {
      action: 'ignore',
      reason: `recorded pid ${record.pid} is alive but its command line doesn't match a sidecar signature (likely PID reuse) - leaving it alone`
    }
  }
  return {
    action: 'kill',
    reason: `recorded pid ${record.pid} (port ${record.port}, started ${record.startedAt}) is alive and matches our sidecar signature - stale from a previous run`
  }
}

/**
 * Deliberately has no `proceed` arm. `decidePortOccupiedAction` is only ever
 * reached once `isPortFree(port)` has already returned false via a real
 * trial bind, so "the port is occupied" is a settled fact by then and every
 * outcome is a refusal - the only open question is how specific the message
 * can be. This used to be a two-arm union, and that shape is exactly what
 * let the empty-`foreignPids` case quietly return `proceed` and defeat the
 * whole module on any platform whose lookup tool is missing (see that
 * function's doc comment). Keeping the impossible arm out of the type means
 * a future edit can't reintroduce that bug without first having to argue
 * with the compiler.
 */
export type PortOccupiedDecision = { action: 'error'; message: string }

/**
 * Pure decision for whether it's safe to spawn on `port`, given the set of
 * PIDs (if any) found still listening on it after the stale-pid-file
 * hygiene step above. Callers only reach this once `isPortFree(port)` has
 * already returned false via a real trial bind - i.e. something IS holding
 * the port - so there are exactly two possible outcomes, and both are a
 * hard error, never a silent "try anyway":
 *
 * - `foreignPids` non-empty: a hard error naming the offending PID(s).
 * - `foreignPids` empty: `findPidsListeningOnPort`'s own doc comment already
 *   documents that it returns `[]` on anything from "tool not installed" to
 *   "output didn't parse" - it is NOT evidence the port is actually free
 *   (that was already ruled out by the trial bind). Treating an empty list
 *   as "safe to proceed" was a pre-existing bug: on a platform where the
 *   lookup tool is missing or fails, it silently defeated this whole
 *   module's purpose (see this module's doc comment - trusting an
 *   unidentified process answering the port is exactly the bug this all
 *   exists to prevent), so this returns a less specific error instead,
 *   naming the port but admitting the occupant couldn't be identified.
 */
export function decidePortOccupiedAction(params: {
  port: number
  foreignPids: number[]
}): PortOccupiedDecision {
  const { port, foreignPids } = params
  if (foreignPids.length === 0) {
    return {
      action: 'error',
      message:
        `Port ${port} is already in use, but the process holding it couldn't be identified ` +
        `(the platform lookup tool is unavailable, or its output couldn't be parsed) - refusing ` +
        `to start a managed sidecar there, since an unidentified process answering that port ` +
        `can't be trusted as "ready". Free up port ${port} (or change the sidecar port in ` +
        `Settings) and try again.`
    }
  }
  const pidList = foreignPids.join(', ')
  return {
    action: 'error',
    message:
      `Port ${port} is already in use by another process (PID ${pidList}) that isn't a stale ` +
      `sidecar of ours - refusing to start a managed sidecar there, since an unidentified ` +
      `process answering that port can't be trusted as "ready". Stop that process (or change ` +
      `the sidecar port in Settings) and try again.`
  }
}

/** `true` if `pid` refers to a currently-running process (any owner) - `process.kill(pid, 0)` sends no signal, just probes existence. `EPERM` means it exists but we lack permission to signal it, which still counts as "alive" for this check. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Best-effort cmdline lookup for `pid`, cross-platform. Returns null (never throws) if it can't be determined - callers must treat that as "unknown", never as a match. */
export function readCmdlineForPid(pid: number): string | null {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync(
        'wmic',
        ['process', 'where', `ProcessId=${pid}`, 'get', 'CommandLine', '/value'],
        { encoding: 'utf-8', timeout: 5000, windowsHide: true }
      )
      if (res.status !== 0 || !res.stdout) return null
      const match = res.stdout.match(/CommandLine=(.+)/)
      return match ? match[1].trim() : null
    }
    if (process.platform === 'darwin') {
      // macOS has no /proc filesystem (that's Linux-only), so the `readFileSync`
      // path below can't work here - `ps -o command= -p <pid>` is the
      // documented BSD-userland way to print one process's full command line
      // by pid. The trailing `=` on `command=` sets an empty header for that
      // column, which per `ps`'s own docs suppresses the header row entirely
      // for a single-column request, so stdout is just the command line (or
      // empty if the pid no longer exists). NOTE: unverified on an actual
      // Mac - nobody on this project has run this on macOS yet; this is
      // based on documented `ps` behavior, not a confirmed capture.
      // `-ww` is load-bearing, not cosmetic. BSD `ps` truncates the command
      // column to the terminal width (falling back to 80 when stdout isn't a
      // tty, which is always the case for this spawn); `-w` widens that to
      // 132 and a second `-w` removes the limit entirely. Our own managed
      // command comfortably exceeds both defaults before it ever reaches the
      // part that identifies it - e.g. "/Users/<user>/Library/Application
      // Support/Blurt/venv/bin/python /Applications/Blurt.app/Contents/
      // Resources/serve_gpu.py serve --host ..." puts "serve_gpu.py" past
      // column 110 - so a truncated line would fail
      // `matchesSidecarSignature`, `decideStalePidAction` would decline to
      // reclaim a sidecar that really was ours, and the stale process would
      // keep the port forever. That is the exact failure this darwin branch
      // exists to prevent, so it must not be reintroduced by the tool's
      // default formatting.
      const res = spawnSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 5000
      })
      if (res.status !== 0 || !res.stdout) return null
      return res.stdout.trim()
    }
    return readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim()
  } catch {
    return null
  }
}

/** Parses Windows `netstat -ano` output, returning the distinct PIDs with a `LISTENING` socket bound to `port` on any local address. Pure/testable against captured real output. */
export function parseNetstatListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>()
  const suffix = `:${port}`
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line.startsWith('TCP')) continue
    if (!line.includes('LISTENING')) continue
    const cols = line.split(/\s+/)
    const localAddr = cols[1] ?? ''
    if (!localAddr.endsWith(suffix)) continue
    const pid = Number(cols[cols.length - 1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** Parses Linux `ss -ltnp` output the same way, for the WSL/Linux dev path. Pure/testable against captured real output. */
export function parseSsListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>()
  const suffix = `:${port}`
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes('LISTEN')) continue
    const cols = line.trim().split(/\s+/)
    const localAddr = cols[3] ?? ''
    if (!localAddr.endsWith(suffix)) continue
    const match = line.match(/pid=(\d+)/)
    if (match) pids.add(Number(match[1]))
  }
  return [...pids]
}

/**
 * Parses macOS `lsof -nP -iTCP:<port> -sTCP:LISTEN` output the same way.
 * Real rows look like:
 *
 *   COMMAND     PID    USER   FD   TYPE             DEVICE SIZE/OFF NODE NAME
 *   python3.1 54321 garrett   12u  IPv4 0x8f3a2b1c9d0e4f56      0t0  TCP 127.0.0.1:9379 (LISTEN)
 *
 * PID is the second whitespace-separated column; the local address is the
 * second-to-last column (the last is always the `(LISTEN)`/`(ESTABLISHED)`
 * state marker, once one is present) - reading the address from the end
 * rather than a fixed index tolerates the COMMAND/USER columns' widths
 * varying. The same pid commonly appears twice (once per IPv4/IPv6 socket),
 * so results are deduplicated. Pure/testable against captured-looking
 * output.
 */
export function parseLsofListeningPids(output: string, port: number): number[] {
  const pids = new Set<number>()
  const suffix = `:${port}`
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('COMMAND')) continue // header row (or blank line)
    if (!/\(LISTEN\)$/.test(line)) continue // only LISTEN rows, not e.g. ESTABLISHED
    const cols = line.split(/\s+/)
    const addr = cols[cols.length - 2] ?? ''
    if (!addr.endsWith(suffix)) continue
    const pid = Number(cols[1])
    if (Number.isInteger(pid) && pid > 0) pids.add(pid)
  }
  return [...pids]
}

/** Best-effort, cross-platform "who's listening on this port" lookup, for building a clear error message. Returns `[]` (never throws) if the platform tool isn't available or its output can't be parsed - the caller must still refuse to proceed in that case, just with a less specific message. */
export function findPidsListeningOnPort(port: number): number[] {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('netstat', ['-ano'], {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true
      })
      if (res.status !== 0 || !res.stdout) return []
      return parseNetstatListeningPids(res.stdout, port)
    }
    if (process.platform === 'darwin') {
      // Neither Linux's `ss` nor Windows' `netstat -ano` exist on macOS -
      // `lsof` is the standard BSD-userland way to find which process holds
      // a TCP port. `-sTCP:LISTEN` asks lsof itself to filter to listening
      // sockets; `parseLsofListeningPids` still checks the state marker
      // defensively rather than trusting that filter blindly, same as the
      // other two parsers double-check their own tool's output. NOTE:
      // unverified on an actual Mac - nobody on this project has run this on
      // macOS yet; this is based on documented `lsof` behavior, not a
      // confirmed capture.
      const res = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], {
        encoding: 'utf-8',
        timeout: 5000
      })
      if (res.status !== 0 || !res.stdout) return []
      return parseLsofListeningPids(res.stdout, port)
    }
    const res = spawnSync('ss', ['-ltnp'], { encoding: 'utf-8', timeout: 5000 })
    if (res.status !== 0 || !res.stdout) return []
    return parseSsListeningPids(res.stdout, port)
  } catch {
    return []
  }
}

/** Whether `port` can be bound on `host` right now - a real trial bind/close, not a parsed tool's output, so it's authoritative and platform-agnostic (unlike `findPidsListeningOnPort`, which is best-effort and only used for the error message's PID). */
export function isPortFree(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const tester = net.createServer()
    tester.once('error', () => resolve(false))
    tester.once('listening', () => tester.close(() => resolve(true)))
    tester.listen(port, host)
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function readPidRecord(pidFilePath: string): SidecarPidRecord | null {
  try {
    if (!existsSync(pidFilePath)) return null
    return parsePidFileContent(readFileSync(pidFilePath, 'utf-8'))
  } catch {
    return null
  }
}

export function writePidFile(pidFilePath: string, record: SidecarPidRecord): void {
  try {
    writeFileSync(pidFilePath, serializePidRecord(record))
  } catch (err) {
    log.warn(
      `sidecar-hygiene: failed to write pid file ${pidFilePath}: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

export function removePidFile(pidFilePath: string): void {
  try {
    if (existsSync(pidFilePath)) unlinkSync(pidFilePath)
  } catch {
    // Best-effort only - a leftover file just gets re-evaluated (and, if
    // genuinely stale, cleaned up) on the next spawn attempt.
  }
}

export type PortGuardResult = { action: 'proceed' } | { action: 'error'; message: string }

/**
 * Runs both hygiene steps (see this module's doc comment) before a managed
 * sidecar spawn: reclaim our own stale pid-file'd process if there is one,
 * then hard-refuse if the port is still occupied by anyone else. Always
 * removes the pid file on the way out - either it was just reclaimed
 * (stale), or it never matched (in which case it's not ours to trust
 * either), and a fresh one is written after the new child actually spawns.
 */
export async function reclaimPortForSpawn(params: {
  port: number
  pidFilePath: string
}): Promise<PortGuardResult> {
  const { port, pidFilePath } = params
  const record = readPidRecord(pidFilePath)

  if (record) {
    const isAlive = isProcessAlive(record.pid)
    const cmdline = isAlive ? readCmdlineForPid(record.pid) : null
    const decision = decideStalePidAction({ record, isAlive, cmdline })
    if (decision.action === 'kill') {
      log.warn(`sidecar-hygiene: ${decision.reason} - killing it`)
      try {
        process.kill(record.pid)
      } catch (err) {
        log.warn(
          `sidecar-hygiene: failed to kill stale pid ${record.pid}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
      // Give the OS a moment to actually release the socket before we
      // check/rebind it below.
      await sleep(300)
    } else {
      log.info(`sidecar-hygiene: ${decision.reason}`)
    }
    removePidFile(pidFilePath)
  }

  if (await isPortFree(port)) return { action: 'proceed' }

  // Past the trial bind above, the port is occupied by definition, so this
  // is always a refusal - no `action === 'error'` check to make first (see
  // PortOccupiedDecision).
  const foreignPids = findPidsListeningOnPort(port)
  const decision = decidePortOccupiedAction({ port, foreignPids })
  log.error(`sidecar-hygiene: ${decision.message}`)
  return decision
}
