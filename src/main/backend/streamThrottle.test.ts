import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ThrottledTextEmitter } from './streamThrottle'

describe('ThrottledTextEmitter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first push immediately', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.push('a')

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('a')
  })

  it('suppresses pushes inside the throttle window, scheduling exactly one trailing emit', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.push('a') // leading emit
    throttled.push('ab')
    throttled.push('abc')
    throttled.push('abcd')

    expect(emit).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(100)

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith('abcd')
  })

  it('emits again immediately once the window has elapsed since the last emit', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.push('a')
    vi.advanceTimersByTime(150)
    throttled.push('b')

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith('b')
  })

  it('flush cancels a pending trailing emit and emits synchronously with the given text', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.push('a') // leading emit at t=0
    throttled.push('ab') // schedules a trailing emit for t=100

    throttled.flush('final')

    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith('final')

    // The cancelled trailing timer must not fire a stale third emit later.
    vi.advanceTimersByTime(200)
    expect(emit).toHaveBeenCalledTimes(2)
  })

  it('flush with no argument re-emits the last pushed value', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.push('a')
    throttled.push('ab')
    throttled.flush()

    expect(emit).toHaveBeenLastCalledWith('ab')
  })

  it('flush with no prior push emits an empty string', () => {
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 100, emit })

    throttled.flush()

    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith('')
  })

  it('respects an injected clock instead of Date.now', () => {
    let now = 1000
    const emit = vi.fn()
    const throttled = new ThrottledTextEmitter({ intervalMs: 50, emit, now: () => now })

    throttled.push('a')
    expect(emit).toHaveBeenCalledTimes(1)

    now += 10
    throttled.push('ab') // still inside the window relative to injected clock - schedules real setTimeout

    vi.advanceTimersByTime(40) // real timer fires at wait = 50 - 10 = 40ms
    expect(emit).toHaveBeenCalledTimes(2)
    expect(emit).toHaveBeenLastCalledWith('ab')
  })
})
