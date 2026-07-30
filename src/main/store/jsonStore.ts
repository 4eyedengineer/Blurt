import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '../log'

/** Leading byte-order-mark some Windows tools (notably PowerShell 5.1's default `-Encoding UTF8`) prepend to "UTF-8" files. Not valid JSON, but trivially safe to strip. */
const BOM = '﻿'

/**
 * Minimal synchronous JSON-file-backed store. Good enough for the small
 * amount of local state this app persists (history + settings) - no need
 * for a real database.
 */
export class JsonStore<T> {
  private cache: T | null = null

  constructor(
    private readonly filePath: string,
    private readonly defaultValue: T
  ) {}

  read(): T {
    if (this.cache !== null) return this.cache

    let result: T
    try {
      if (existsSync(this.filePath)) {
        let raw = readFileSync(this.filePath, 'utf-8')
        if (raw.charCodeAt(0) === BOM.charCodeAt(0)) {
          log.info(`jsonStore: stripped a leading BOM from ${this.filePath}`)
          raw = raw.slice(1)
        }
        const parsed = JSON.parse(raw)
        if (Array.isArray(this.defaultValue)) {
          result = (Array.isArray(parsed) ? parsed : this.defaultValue) as T
        } else {
          result = { ...this.defaultValue, ...parsed }
        }
      } else {
        result = this.defaultValue
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.error(`jsonStore: failed to read ${this.filePath}, using default: ${reason}`)
      // A parse failure would otherwise repeat on every boot (defaults are
      // used but never persisted back here) and silently mask whatever bad
      // data is sitting on disk. Quarantine the offending file - preserves
      // it as evidence for whoever's debugging, and clears the path so a
      // subsequent write() starts clean instead of re-hitting this same
      // error forever. Defaults are still used for *this* boot either way -
      // the app must come up regardless.
      this.quarantineInvalidFile()
      result = this.defaultValue
    }

    this.cache = result
    return result
  }

  /** Renames an unparseable file out of the way so it's never silently retried, while keeping it around as evidence. Best-effort: a failure here is logged but never thrown - the caller already has defaults to fall back to. */
  private quarantineInvalidFile(): void {
    if (!existsSync(this.filePath)) return
    const quarantinePath = `${this.filePath}.invalid-${Date.now()}`
    try {
      renameSync(this.filePath, quarantinePath)
      log.error(
        `jsonStore: moved unreadable file to ${quarantinePath} (using defaults instead) - inspect it to see what was wrong`
      )
    } catch (renameErr) {
      const reason = renameErr instanceof Error ? renameErr.message : String(renameErr)
      log.error(`jsonStore: also failed to quarantine ${this.filePath}: ${reason}`)
    }
  }

  write(value: T): void {
    this.cache = value
    try {
      mkdirSync(dirname(this.filePath), { recursive: true })
      writeFileSync(this.filePath, JSON.stringify(value, null, 2), 'utf-8')
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      log.error(`jsonStore: failed to write ${this.filePath}: ${reason}`)
    }
  }
}
