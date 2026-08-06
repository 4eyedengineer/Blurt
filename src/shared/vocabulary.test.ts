import { describe, expect, it } from 'vitest'
import { applyVocabularyCorrections, parseVocabulary } from './vocabulary'

describe('parseVocabulary', () => {
  it('treats a plain entry as spelling guidance', () => {
    expect(parseVocabulary(['Kubernetes', 'LiteRT'])).toEqual({
      spellings: ['Kubernetes', 'LiteRT'],
      corrections: []
    })
  })

  it('treats an arrow entry as a correction', () => {
    expect(parseVocabulary(['Quin -> Qwen'])).toEqual({
      spellings: [],
      corrections: [{ from: 'Quin', to: 'Qwen' }]
    })
  })

  it('keeps both kinds in one list', () => {
    const parsed = parseVocabulary(['Kubernetes', 'Quin -> Qwen'])
    expect(parsed.spellings).toEqual(['Kubernetes'])
    expect(parsed.corrections).toEqual([{ from: 'Quin', to: 'Qwen' }])
  })

  it('tolerates missing spaces around the arrow', () => {
    expect(parseVocabulary(['Quin->Qwen']).corrections).toEqual([{ from: 'Quin', to: 'Qwen' }])
  })

  /**
   * A half-written entry is a typo, not an instruction. Guessing at it would
   * mean silently replacing every occurrence of a term with nothing, or
   * inserting a word the user never wrote.
   */
  it('drops an entry with a blank side rather than guessing', () => {
    const parsed = parseVocabulary(['-> Qwen', 'Quin ->', '  ', ''])
    expect(parsed).toEqual({ spellings: [], corrections: [] })
  })

  it('handles an absent list', () => {
    expect(parseVocabulary(undefined)).toEqual({ spellings: [], corrections: [] })
  })
})

describe('applyVocabularyCorrections', () => {
  const qwen = [{ from: 'Quin', to: 'Qwen' }]

  it('replaces the term wherever it appears', () => {
    expect(applyVocabularyCorrections('Can we fit Quin 3.6 next to Quin 30B?', qwen)).toBe(
      'Can we fit Qwen 3.6 next to Qwen 30B?'
    )
  })

  /**
   * The recogniser is inconsistent about which misspelling it lands on - the
   * dictation that prompted this feature contained both "Quin" and "Quinn" -
   * so one entry has to cover the casing variants at least.
   */
  it('matches case-insensitively and writes the replacement as given', () => {
    expect(applyVocabularyCorrections('quin and QUIN', qwen)).toBe('Qwen and Qwen')
  })

  it('does not match inside a longer word', () => {
    expect(applyVocabularyCorrections('Quincy went to Quin', qwen)).toBe('Quincy went to Qwen')
  })

  it('replaces multi-word terms', () => {
    expect(
      applyVocabularyCorrections('the check point release', [
        { from: 'check point', to: 'Checkpoint' }
      ])
    ).toBe('the Checkpoint release')
  })

  it('matches a term ending in punctuation, where a word boundary cannot apply', () => {
    expect(
      applyVocabularyCorrections('written in C plus plus', [{ from: 'C plus plus', to: 'C++' }])
    ).toBe('written in C++')
    expect(applyVocabularyCorrections('C++ is fine', [{ from: 'C++', to: 'Cpp' }])).toBe(
      'Cpp is fine'
    )
  })

  /**
   * Applied in one pass, so a correction can never rewrite what another one
   * just produced. Sequential replacement would turn "alpha" into "gamma"
   * here, which is not what either rule says.
   */
  it('never chains one correction into another', () => {
    const chained = [
      { from: 'alpha', to: 'beta' },
      { from: 'beta', to: 'gamma' }
    ]
    expect(applyVocabularyCorrections('alpha beta', chained)).toBe('beta gamma')
  })

  it('prefers the longer term when one is a prefix of another', () => {
    const corrections = [
      { from: 'Quin', to: 'Qwen' },
      { from: 'Quin Max', to: 'Qwen Max' }
    ]
    expect(applyVocabularyCorrections('Quin Max and Quin', corrections)).toBe('Qwen Max and Qwen')
  })

  it('escapes regex metacharacters in the term', () => {
    expect(applyVocabularyCorrections('use dot star here', [{ from: '.*', to: 'X' }])).toBe(
      'use dot star here'
    )
    expect(applyVocabularyCorrections('a .* b', [{ from: '.*', to: 'X' }])).toBe('a X b')
  })

  it('leaves the text alone when there is nothing to do', () => {
    expect(applyVocabularyCorrections('untouched', [])).toBe('untouched')
    expect(applyVocabularyCorrections('', qwen)).toBe('')
  })
})
