import { describe, expect, it } from 'vitest'
import { stitchTranscript } from './transcriptStitcher'

describe('stitchTranscript', () => {
  it('returns the window text as-is when there is no committed text yet', () => {
    expect(stitchTranscript('', 'the quick brown fox')).toBe('the quick brown fox')
  })

  it('returns the committed text as-is when the window text is empty', () => {
    expect(stitchTranscript('the quick brown fox', '')).toBe('the quick brown fox')
  })

  it('handles both empty', () => {
    expect(stitchTranscript('', '')).toBe('')
  })

  it('concatenates with no overlap when the window shares no words with committed', () => {
    expect(stitchTranscript('the quick brown fox', 'jumps over the lazy dog')).toBe(
      'the quick brown fox jumps over the lazy dog'
    )
  })

  it('drops a fully-repeated window (full overlap) - window is a strict subset of committed tail', () => {
    expect(stitchTranscript('the quick brown fox jumps', 'brown fox jumps')).toBe(
      'the quick brown fox jumps'
    )
  })

  it('dedupes a partial word-level overlap and appends only the new words', () => {
    expect(stitchTranscript('the quick brown fox', 'brown fox jumps over')).toBe(
      'the quick brown fox jumps over'
    )
  })

  it('matches the longest possible overlap, not just the first one found', () => {
    // "fox" alone also matches at position 0 of a shorter candidate, but the
    // 3-word run "brown fox jumps" is the longest valid overlap and should
    // win, appending only "over the lazy dog".
    expect(stitchTranscript('the quick brown fox jumps', 'brown fox jumps over the lazy dog')).toBe(
      'the quick brown fox jumps over the lazy dog'
    )
  })

  it('is case-insensitive when matching overlap', () => {
    expect(stitchTranscript('The Quick Brown Fox', 'brown fox jumps')).toBe(
      'The Quick Brown Fox jumps'
    )
  })

  it('is punctuation-insensitive when matching overlap', () => {
    expect(stitchTranscript('The quick brown fox.', 'fox jumps over')).toBe(
      'The quick brown fox. jumps over'
    )
  })

  it('handles a word cut off mid-word at the committed boundary (partial-word case)', () => {
    // Committed text ends with a truncated "sto" (window boundary landed
    // mid-word); the next window's transcript starts with the complete
    // "store" - the truncated copy should be dropped in favor of the
    // complete word, not shown as "the sto store yesterday".
    expect(stitchTranscript('I went to the sto', 'store yesterday')).toBe(
      'I went to the store yesterday'
    )
  })

  it('does not apply the partial-word heuristic when the words are unrelated', () => {
    // "a" is a prefix of "apple" by the same startsWith check, but a single
    // ultra-short word like this is exactly the kind of case real prefix
    // matches would produce false positives for elsewhere - verify no
    // special-casing beyond the real regression case is silently smuggled
    // in. Since "a" is only 1 char, the heuristic requires a non-trivial
    // truncated word, so this should just concatenate normally.
    expect(stitchTranscript('I ate a', 'apple today')).toBe('I ate a apple today')
  })

  it('handles single-word committed and window texts', () => {
    expect(stitchTranscript('hello', 'hello world')).toBe('hello world')
    expect(stitchTranscript('hello', 'goodbye')).toBe('hello goodbye')
  })

  it('collapses extra whitespace in both inputs', () => {
    expect(stitchTranscript('the   quick  brown', '  brown   fox  ')).toBe('the quick brown fox')
  })
})
