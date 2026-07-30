import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname } from 'path'
import { log } from '../log'

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
        const raw = readFileSync(this.filePath, 'utf-8')
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
      result = this.defaultValue
    }

    this.cache = result
    return result
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
