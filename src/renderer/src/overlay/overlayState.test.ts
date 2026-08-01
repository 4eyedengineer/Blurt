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
      diffTokens: [{ op: 'equal', before: 'stale', after: 'stale' }],
      copied: true,
      pasted: true,
      pasteMessage: 'stale message',
      errorMessage: null
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

  it('moves cleaning -> revealing on cleaned, storing the final text and a word diff', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', raw: 'um hello world', text: 'Hello world.' })
    expect(state.phase).toBe('revealing')
    expect(state.finalText).toBe('Hello world.')
    expect(state.diffTokens.length).toBeGreaterThan(0)
    expect(state.diffTokens.some((t) => t.op === 'delete' && t.before === 'um')).toBe(true)
  })

  it('ignores cleaned outside the cleaning phase', () => {
    const next = overlayReducer(initialOverlayState, {
      type: 'cleaned',
      raw: 'nope',
      text: 'nope'
    })
    expect(next).toBe(initialOverlayState)
  })

  it('moves revealing -> done on settle', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', raw: 'hello', text: 'Hello.' })
    const next = overlayReducer(state, { type: 'settle' })
    expect(next.phase).toBe('done')
    expect(next.finalText).toBe('Hello.')
  })

  it('ignores settle outside the revealing phase', () => {
    const next = overlayReducer(initialOverlayState, { type: 'settle' })
    expect(next).toBe(initialOverlayState)
  })

  it('applies paste-status during revealing or done, ignores it otherwise', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'cleaned', raw: 'text', text: 'Text.' })
    expect(state.phase).toBe('revealing')

    const duringReveal = overlayReducer(state, {
      type: 'paste-status',
      copied: true,
      pasted: true,
      message: 'Copied and pasted.'
    })
    expect(duringReveal.copied).toBe(true)
    expect(duringReveal.pasted).toBe(true)
    expect(duringReveal.pasteMessage).toBe('Copied and pasted.')

    const settled = overlayReducer(duringReveal, { type: 'settle' })
    const afterSettle = overlayReducer(settled, {
      type: 'paste-status',
      copied: true,
      pasted: false,
      message: 'Copied only.'
    })
    expect(afterSettle.pasteMessage).toBe('Copied only.')

    const ignored = overlayReducer(initialOverlayState, {
      type: 'paste-status',
      copied: true,
      pasted: true,
      message: 'should be ignored'
    })
    expect(ignored).toBe(initialOverlayState)
  })

  it('failed moves an active phase -> error with the failure message, ignored when idle', () => {
    const recording = overlayReducer(initialOverlayState, { type: 'start' })
    const next = overlayReducer(recording, {
      type: 'failed',
      message: 'Microphone capture failed: denied'
    })
    expect(next.phase).toBe('error')
    expect(next.errorMessage).toBe('Microphone capture failed: denied')

    const ignored = overlayReducer(initialOverlayState, {
      type: 'failed',
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
    state = overlayReducer(state, { type: 'cleaned', raw: 'text', text: 'Text.' })
    const next = overlayReducer(state, { type: 'reset' })
    expect(next).toEqual(initialOverlayState)

    const noop = overlayReducer(initialOverlayState, { type: 'reset' })
    expect(noop).toBe(initialOverlayState)
  })
})

/**
 * 'no-speech' is deliberately its own phase rather than a 'failed' with a
 * friendly message: nothing went wrong. The mic opened, capture ran, the
 * model was asked and correctly answered "nobody said anything". Rendering
 * that in the error style would train the user to distrust a working app.
 */
describe('overlayReducer - no-speech', () => {
  it('moves from cleaning to the no-speech phase with no text and no error', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'partial', text: 'partial that turned out to be noise' })
    state = overlayReducer(state, { type: 'stop' })
    const next = overlayReducer(state, { type: 'no-speech' })

    expect(next.phase).toBe('no-speech')
    expect(next.errorMessage).toBeNull()
    expect(next.finalText).toBe('')
    // The discarded live text must not survive - it is exactly the
    // provisional guess the final pass just overruled.
    expect(next.liveText).toBe('')
  })

  it('is a no-op outside the cleaning phase', () => {
    expect(overlayReducer(initialOverlayState, { type: 'no-speech' })).toBe(initialOverlayState)

    const recording = overlayReducer(initialOverlayState, { type: 'start' })
    expect(overlayReducer(recording, { type: 'no-speech' })).toBe(recording)
  })

  it('resets back to idle like any other terminal phase', () => {
    let state = overlayReducer(initialOverlayState, { type: 'start' })
    state = overlayReducer(state, { type: 'stop' })
    state = overlayReducer(state, { type: 'no-speech' })
    expect(overlayReducer(state, { type: 'reset' })).toEqual(initialOverlayState)
  })
})
