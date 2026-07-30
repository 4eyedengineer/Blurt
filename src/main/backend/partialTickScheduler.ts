/**
 * Pure decision logic for when `LitertBackend.pushAudio` is allowed to fire
 * the next partial-transcription tick - factored out of `litertBackend.ts`
 * so the scheduling rule (and its regression history) is independently
 * unit-testable with an injectable clock, no fake session/fetch plumbing
 * needed.
 *
 * Background (see scratchpad/perf-review.md §1 "spiral" finding): the
 * original guard only checked "has enough new audio arrived since the last
 * tick *launched*, and is no tick currently in flight" - `msSinceLastPartial`
 * kept accruing for the whole duration a tick was in flight, so the instant
 * a slow tick completed, the very next `pushAudio` call would already be
 * over threshold and launch immediately, back-to-back, with zero breathing
 * room. Rolling-window partial ticks (see `DEFAULT_PARTIAL_WINDOW_MS` in
 * litertBackend.ts) already bound the *cost* of each tick regardless of
 * session length, but on genuinely slow (CPU-only) hardware a tick can still
 * take longer than `intervalMs`, so back-to-back launches with no gap would
 * still peg the CPU and starve everything else running on the machine.
 * `minIdleGapMs` enforces a minimum real-world idle gap after a tick
 * *completes* before the next one is allowed to launch, so slow hardware
 * degrades to a slower (but stable) cadence instead of a growing backlog.
 */
export interface PartialTickGateState {
  /** ms of new audio that has arrived since the currently-in-flight (or most recently completed) tick took its buffer snapshot. */
  msSinceSnapshot: number
  /** Whether a partial tick is currently in flight (never launch a second one concurrently). */
  tickInFlight: boolean
  /** Wall-clock time (per the caller's clock) the most recently completed tick finished, or null if none has ever completed. */
  lastCompletionAtMs: number | null
}

export interface PartialTickGateParams {
  /** ms of new audio required since the last snapshot before a tick is even considered. */
  intervalMs: number
  /** Minimum real-world ms required between a tick's completion and the next tick's launch. */
  minIdleGapMs: number
  /** Current wall-clock time, from the caller's (injectable, for tests) clock. */
  nowMs: number
}

/** Pure yes/no: should a new partial tick launch right now? */
export function shouldLaunchPartialTick(
  state: PartialTickGateState,
  params: PartialTickGateParams
): boolean {
  if (state.tickInFlight) return false
  if (state.msSinceSnapshot < params.intervalMs) return false
  if (
    state.lastCompletionAtMs !== null &&
    params.nowMs - state.lastCompletionAtMs < params.minIdleGapMs
  ) {
    return false
  }
  return true
}
