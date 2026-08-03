import { describe, expect, it } from 'vitest'
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
