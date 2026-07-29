import { describe, expect, it } from 'vitest'
import { initialOverlayState, overlayReducer, type OverlayState } from './overlayState'

describe('overlayReducer', () => {
  it('starts idle', () => {
    expect(initialOverlayState.phase).toBe('idle')
  })

  it('start always resets to a fresh recording state', () => {
    const dirty: OverlayState = {
      phase: 'done',
      liveText: 'stale',
      finalText: 'stale final',
      copied: true,
      pasted: true,
      pasteMessage: 'stale message'
    }
    const next = overlayReducer(dirty, { type: 'start' })
    expect(next).toEqual({ ...initialOverlayState, phase: 'recording' })
  })

  it('applies partial transcripts while recording', () => {
    const recording = overlayReducer(initialOverlayState, { type: 'start' })
    const next = overlayReducer(recording, { type: 'partial', text: 'hello wor' })
    expect(next.phase).toBe('recording')
    expect(next.liveText).toBe('hello wor')
  })

  it('ignores partial transcripts outside the recording phase', () => {
    const next = overlayReducer(initialOverlayState, { type: 'partial', text: 'ignored' })
    expect(next).toBe(initialOverlayState)
  })

  it('moves recording -> cleaning on stop', () => {
    const recording = overlayReducer(initialOverlayState, { type: 'start' })
    const next = overlayReducer(recording, { type: 'stop' })
    expect(next.phase).toBe('cleaning')
  })

  it('ignores stop outside the recording phase', () => {
    const next = overlayReducer(initialOverlayState, { type: 'stop' })
    expect(next).toBe(initialOverlayState)
  })

  it('moves cleaning -> done on cleaned, storing the final text', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', text: 'Hello world.' })
    expect(state.phase).toBe('done')
    expect(state.finalText).toBe('Hello world.')
  })

  it('ignores cleaned outside the cleaning phase', () => {
    const next = overlayReducer(initialOverlayState, { type: 'cleaned', text: 'nope' })
    expect(next).toBe(initialOverlayState)
  })

  it('applies paste-status only in the done phase', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', text: 'text' })
    const next = overlayReducer(state, {
      type: 'paste-status',
      copied: true,
      pasted: true,
      message: 'Copied and pasted.'
    })
    expect(next.copied).toBe(true)
    expect(next.pasted).toBe(true)
    expect(next.pasteMessage).toBe('Copied and pasted.')

    const ignored = overlayReducer(initialOverlayState, {
      type: 'paste-status',
      copied: true,
      pasted: true,
      message: 'should be ignored'
    })
    expect(ignored).toBe(initialOverlayState)
  })

  it('cancel resets to idle from any non-idle phase', () => {
    const recording = overlayReducer(initialOverlayState, { type: 'start' })
    const next = overlayReducer(recording, { type: 'cancel' })
    expect(next).toEqual(initialOverlayState)
  })

  it('cancel on an already-idle state returns the same reference (no-op)', () => {
    const next = overlayReducer(initialOverlayState, { type: 'cancel' })
    expect(next).toBe(initialOverlayState)
  })

  it('reset resets to idle from any non-idle phase, and no-ops when already idle', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', text: 'text' })
    const next = overlayReducer(state, { type: 'reset' })
    expect(next).toEqual(initialOverlayState)

    const noop = overlayReducer(initialOverlayState, { type: 'reset' })
    expect(noop).toBe(initialOverlayState)
  })
})
