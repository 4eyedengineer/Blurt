import { describe, expect, it } from 'vitest'
import { canRevertToCleaned } from './historyEntry'

describe('canRevertToCleaned', () => {
  it('is false when displayText already equals cleanedText - nothing to revert to', () => {
    expect(canRevertToCleaned({ displayText: 'hello world', cleanedText: 'hello world' })).toBe(
      false
    )
  })

  it('is true when displayText differs from cleanedText', () => {
    expect(canRevertToCleaned({ displayText: 'Hello, world.', cleanedText: 'hello world' })).toBe(
      true
    )
  })

  it('is false when cleanedText is empty - reverting would just blank the row', () => {
    expect(canRevertToCleaned({ displayText: 'hello world', cleanedText: '' })).toBe(false)
  })

  it('is true when a transform (e.g. Key Points) rewrote displayText away from cleanedText', () => {
    expect(
      canRevertToCleaned({
        displayText: '- hello\n- world',
        cleanedText: 'hello world'
      })
    ).toBe(true)
  })

  it('is false when both are empty - an entry with no cleaned text yet', () => {
    expect(canRevertToCleaned({ displayText: '', cleanedText: '' })).toBe(false)
  })
})
