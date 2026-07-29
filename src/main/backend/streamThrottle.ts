/**
 * Batches a rapidly-updating "latest full text" stream (e.g. SSE deltas
 * arriving many times a second while a transcription/cleanup/transform
 * request streams in) down to at most one `emit` call per `intervalMs` -
 * see LitertBackend's partial-transcription and cleanup/transform/voiceEdit
 * streaming, which would otherwise spam the renderer over IPC on every
 * single token.
 *
 * This is a trailing-edge throttle with an immediate leading emit: the
 * first `push` after being idle for `intervalMs` (or longer) emits right
 * away; pushes that arrive faster than that schedule exactly one trailing
 * emit carrying whatever was most recently pushed by the time it fires.
 * `push` always carries the *whole* accumulated text so far (not a
 * fragment), since each new streaming tick's result is meant to replace the
 * previously-shown text rather than append to it.
 *
 * Pure logic (no fetch/IPC) with an injectable clock so it's deterministic
 * to unit test with vitest's fake timers - see streamThrottle.test.ts.
 */
export interface ThrottledTextEmitterOptions {
  /** Minimum ms between consecutive `emit` calls. */
  intervalMs: number
  /** Called with the latest pushed text, at most once per `intervalMs`. */
  emit: (text: string) => void
  /** Injectable clock, for tests. Defaults to `Date.now`. */
  now?: () => number
}

export class ThrottledTextEmitter {
  private readonly intervalMs: number
  private readonly emitFn: (text: string) => void
  private readonly now: () => number
  private latest = ''
  private lastEmitAt = -Infinity
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(options: ThrottledTextEmitterOptions) {
    this.intervalMs = options.intervalMs
    this.emitFn = options.emit
    this.now = options.now ?? Date.now
  }

  /**
   * Records the latest text. Emits immediately if the throttle window has
   * elapsed since the last emit; otherwise schedules (or leaves already
   * scheduled) a single trailing emit for when the window closes.
   */
  push(text: string): void {
    this.latest = text
    if (this.timer) return // a trailing emit is already scheduled - it will pick up `latest` when it fires

    const elapsed = this.now() - this.lastEmitAt
    if (elapsed >= this.intervalMs) {
      this.emitNow()
      return
    }

    const wait = this.intervalMs - elapsed
    this.timer = setTimeout(() => {
      this.timer = null
      this.emitNow()
    }, wait)
  }

  /**
   * Cancels any pending trailing emit and emits synchronously right away -
   * call once a stream completes so the exact final value is always
   * delivered with no trailing delay. Updates the latest text first if
   * `text` is given (the caller's authoritative final value may differ
   * slightly from the last streamed chunk, e.g. after preamble-stripping).
   */
  flush(text?: string): void {
    if (text !== undefined) this.latest = text
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emitNow()
  }

  private emitNow(): void {
    this.lastEmitAt = this.now()
    this.emitFn(this.latest)
  }
}
