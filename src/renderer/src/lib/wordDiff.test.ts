import { describe, expect, it } from 'vitest'
import { diffWords } from './wordDiff'

describe('diffWords', () => {
  it('returns an empty diff for two empty inputs', () => {
    expect(diffWords('', '')).toEqual([])
  })

  it('treats an empty before as pure insertions', () => {
    expect(diffWords('', 'hello world')).toEqual([
      { op: 'insert', after: 'hello' },
      { op: 'insert', after: 'world' }
    ])
  })

  it('treats an empty after as pure deletions', () => {
    expect(diffWords('hello world', '')).toEqual([
      { op: 'delete', before: 'hello' },
      { op: 'delete', before: 'world' }
    ])
  })

  it('marks identical texts as fully equal', () => {
    const tokens = diffWords('the quick fox', 'the quick fox')
    expect(tokens).toEqual([
      { op: 'equal', before: 'the', after: 'the' },
      { op: 'equal', before: 'quick', after: 'quick' },
      { op: 'equal', before: 'fox', after: 'fox' }
    ])
  })

  it('treats a case-only difference as equal, not a change', () => {
    const tokens = diffWords('hello world', 'Hello world')
    expect(tokens[0]).toEqual({ op: 'equal', before: 'hello', after: 'Hello' })
  })

  it('detects a pure deletion in the middle of the text', () => {
    const tokens = diffWords('we um need to leave', 'we need to leave')
    expect(tokens).toEqual([
      { op: 'equal', before: 'we', after: 'we' },
      { op: 'delete', before: 'um' },
      { op: 'equal', before: 'need', after: 'need' },
      { op: 'equal', before: 'to', after: 'to' },
      { op: 'equal', before: 'leave', after: 'leave' }
    ])
  })

  it('detects a pure insertion in the middle of the text', () => {
    const tokens = diffWords('we need leave', 'we really need to leave')
    expect(tokens).toEqual([
      { op: 'equal', before: 'we', after: 'we' },
      { op: 'insert', after: 'really' },
      { op: 'equal', before: 'need', after: 'need' },
      { op: 'insert', after: 'to' },
      { op: 'equal', before: 'leave', after: 'leave' }
    ])
  })

  it('treats a punctuation-only difference as a replacement', () => {
    const tokens = diffWords('he said hello', 'he said hello.')
    expect(tokens).toEqual([
      { op: 'equal', before: 'he', after: 'he' },
      { op: 'equal', before: 'said', after: 'said' },
      { op: 'replace', before: 'hello', after: 'hello.' }
    ])
  })

  it('treats an added apostrophe as a replacement, not a delete+insert', () => {
    const tokens = diffWords('i dont know', "i don't know")
    expect(tokens).toEqual([
      { op: 'equal', before: 'i', after: 'i' },
      { op: 'replace', before: 'dont', after: "don't" },
      { op: 'equal', before: 'know', after: 'know' }
    ])
  })

  it('shows a wholesale word swap as an adjacent delete+insert, not a replace', () => {
    const tokens = diffWords('i want cats', 'i want dogs')
    expect(tokens).toEqual([
      { op: 'equal', before: 'i', after: 'i' },
      { op: 'equal', before: 'want', after: 'want' },
      { op: 'delete', before: 'cats' },
      { op: 'insert', after: 'dogs' }
    ])
  })

  it('handles a false-start correction (repeated then corrected phrase)', () => {
    // The LCS aligns the *first* "want" occurrence (only differing from the
    // after-text by trailing punctuation, hence 'replace') and drops the
    // repeated "i want" as a delete pair - a valid alignment, just not the
    // only intuitively-possible one, since both "want"s are equally good
    // LCS anchors.
    const tokens = diffWords('i want- i want to go', 'i want to go')
    expect(tokens).toEqual([
      { op: 'equal', before: 'i', after: 'i' },
      { op: 'replace', before: 'want-', after: 'want' },
      { op: 'delete', before: 'i' },
      { op: 'delete', before: 'want' },
      { op: 'equal', before: 'to', after: 'to' },
      { op: 'equal', before: 'go', after: 'go' }
    ])
  })

  it('handles whitespace-only inputs the same as empty', () => {
    expect(diffWords('   ', '  ')).toEqual([])
  })
})
