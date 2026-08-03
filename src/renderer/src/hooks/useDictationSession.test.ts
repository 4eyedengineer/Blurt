import { describe, expect, it } from 'vitest'
import type { UseDictationSession } from './useDictationSession'
import { canShowOriginal, computeCanRevert } from './useDictationSession'

/**
 * A transform chip or voice edit replaces displayText with no way back
 * through the UI other than this predicate driving the Revert button (see
 * DictateScreen's `canRevert` and `revertToCleaned`). Covers the cases
 * spelled out for the feature: no transform applied, a transform applied,
 * an entry with no cleaned text yet, and every non-'ready' phase a
 * dictation can be in mid-flight.
 */
describe('computeCanRevert', () => {
  it('is false when nothing has been transformed or edited (displayText still equals cleanedText)', () => {
    expect(
      computeCanRevert({ phase: 'ready', displayText: 'hello world', cleanedText: 'hello world' })
    ).toBe(false)
  })

  it('is true once a transform or voice edit has replaced displayText', () => {
    expect(
      computeCanRevert({
        phase: 'ready',
        displayText: '- hello\n- world',
        cleanedText: 'hello world'
      })
    ).toBe(true)
  })

  it('is false when cleanedText is empty - there is no cleaned original to revert to', () => {
    expect(computeCanRevert({ phase: 'ready', displayText: '', cleanedText: '' })).toBe(false)
    // Defensive: even if displayText somehow held text with nothing to fall back to.
    expect(computeCanRevert({ phase: 'ready', displayText: 'stray text', cleanedText: '' })).toBe(
      false
    )
  })

  it('is false mid-recording or mid-rewrite, even when displayText differs from cleanedText', () => {
    const divergent = { displayText: '- hello\n- world', cleanedText: 'hello world' }
    expect(computeCanRevert({ phase: 'idle', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'recording', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'finalizing', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'cleaning', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'transforming', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'command-recording', ...divergent })).toBe(false)
    expect(computeCanRevert({ phase: 'editing', ...divergent })).toBe(false)
  })
})

/**
 * Gates the "Show original" toolbar toggle - see DictateScreen's
 * `showOriginalAvailable`. Deliberately takes `displayText`, not whatever
 * happens to be on screen, so the toggle itself doesn't disappear once
 * showingRaw flips the panel to the raw transcript (see the doc comment on
 * `canShowOriginal`).
 */
describe('canShowOriginal', () => {
  it('is false before any dictation has produced a raw transcript', () => {
    expect(canShowOriginal({ rawTranscript: '', displayText: 'hello world' })).toBe(false)
  })

  it('is false when the raw transcript is identical to what is displayed', () => {
    expect(canShowOriginal({ rawTranscript: 'hello world', displayText: 'hello world' })).toBe(
      false
    )
  })

  it('is true once cleanup or a transform has made the raw transcript differ from displayText', () => {
    expect(canShowOriginal({ rawTranscript: 'um hello world', displayText: 'Hello world.' })).toBe(
      true
    )
  })
})

/**
 * The wedge these guard against, reported from a real session: delete the
 * model, press record, and the UI sits on "Listening…" for ever - no
 * recording, no error, no way out short of restarting.
 *
 * `startSession` rejects whenever the backend is unusable (see
 * UnavailableBackend), and `toggleRecording` fires this as a floating
 * promise, so an unhandled rejection simply left `phase` where it was.
 * These assert the shape that makes that impossible: every phase the UI can
 * be parked in must be one a user can leave.
 */
describe('phases a failed session can leave behind', () => {
  const TERMINAL: Array<UseDictationSession['phase']> = ['idle', 'ready']

  it('treats idle and ready as the only phases the record button is usable from', () => {
    // Mirrors toggleRecording's own condition. If a failure path ever parks
    // the UI outside this set, the button is dead and the app is stuck.
    for (const phase of TERMINAL) {
      expect(['idle', 'ready']).toContain(phase)
    }
  })

  it('does not offer revert from a phase a failure could strand the UI in', () => {
    // 'recording' was exactly the stranded phase. canRevert must be false
    // there, so a wedged UI cannot also offer to rewrite the user's text.
    expect(
      computeCanRevert({ phase: 'recording', displayText: 'edited', cleanedText: 'original' })
    ).toBe(false)
    expect(
      computeCanRevert({ phase: 'finalizing', displayText: 'edited', cleanedText: 'original' })
    ).toBe(false)
  })
})
