import { describe, expect, it } from 'vitest'
import { shouldLaunchPartialTick } from './partialTickScheduler'

const BASE_PARAMS = { intervalMs: 1500, minIdleGapMs: 300 }

describe('shouldLaunchPartialTick', () => {
  it('does not launch while a tick is already in flight, regardless of accrued audio', () => {
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 10_000, tickInFlight: true, lastCompletionAtMs: null },
        { ...BASE_PARAMS, nowMs: 100_000 }
      )
    ).toBe(false)
  })

  it('does not launch before enough new audio has accrued', () => {
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 1499, tickInFlight: false, lastCompletionAtMs: null },
        { ...BASE_PARAMS, nowMs: 100_000 }
      )
    ).toBe(false)
  })

  it('launches once enough new audio has accrued and nothing else blocks it (first ever tick)', () => {
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 1500, tickInFlight: false, lastCompletionAtMs: null },
        { ...BASE_PARAMS, nowMs: 100_000 }
      )
    ).toBe(true)
  })

  it('does NOT launch immediately after a tick completes, even with a large accrued backlog - the spiral-guard idle gap', () => {
    // Regression case: previously `msSinceLastPartial` kept accruing during
    // the whole time a tick was in flight, so the instant it completed, the
    // next tick launched immediately (zero gap) since the counter was
    // already far over threshold - a back-to-back spiral on slow hardware.
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 9000, tickInFlight: false, lastCompletionAtMs: 100_000 },
        { ...BASE_PARAMS, nowMs: 100_050 } // only 50ms since completion, gap requires 300ms
      )
    ).toBe(false)
  })

  it('launches once the minimum idle gap since the last completion has elapsed', () => {
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 9000, tickInFlight: false, lastCompletionAtMs: 100_000 },
        { ...BASE_PARAMS, nowMs: 100_300 } // exactly minIdleGapMs later
      )
    ).toBe(true)
  })

  it('launches right at the exact interval boundary (>=, not >)', () => {
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 1500, tickInFlight: false, lastCompletionAtMs: 0 },
        { ...BASE_PARAMS, nowMs: 300 }
      )
    ).toBe(true)
  })

  it('blocks on the idle gap even when the audio backlog is enormous (degraded-cadence behavior on slow hardware)', () => {
    // With rolling windows the per-tick cost is bounded, but this still
    // matters: without the gap, a CPU-only machine that falls slightly
    // behind would fire ticks with no breathing room at all.
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 60_000, tickInFlight: false, lastCompletionAtMs: 5000 },
        { ...BASE_PARAMS, nowMs: 5299 }
      )
    ).toBe(false)
    expect(
      shouldLaunchPartialTick(
        { msSinceSnapshot: 60_000, tickInFlight: false, lastCompletionAtMs: 5000 },
        { ...BASE_PARAMS, nowMs: 5300 }
      )
    ).toBe(true)
  })
})
