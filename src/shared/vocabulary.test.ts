import { describe, expect, it } from 'vitest'
import {
  applyVocabularyCorrections,
  formatCorrection,
  historyWordSuggestions,
  editDistance,
  findMisrecognitions,
  parseVocabulary,
  soundex
} from './vocabulary'

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

describe('soundex', () => {
  /**
   * The case the feature exists for. These are three edits apart on a
   * four-letter word, so no edit-distance threshold could safely connect
   * them - the recogniser's mistake is phonetic, not orthographic.
   */
  it('puts the recogniser’s spellings and the real one in the same bucket', () => {
    expect(soundex('Quin')).toBe(soundex('Qwen'))
    expect(soundex('Quinn')).toBe(soundex('Qwen'))
    expect(editDistance('quinn', 'qwen')).toBe(3)
  })

  it('separates words that do not sound alike', () => {
    expect(soundex('Kubernetes')).not.toBe(soundex('Qwen'))
    expect(soundex('Parakeet')).not.toBe(soundex('Gemma'))
  })

  it('is stable for the classic reference values', () => {
    expect(soundex('Robert')).toBe('R163')
    expect(soundex('Rupert')).toBe('R163')
    expect(soundex('Ashcraft')).toBe('A261')
    expect(soundex('Tymczak')).toBe('T522')
  })
})

describe('findMisrecognitions', () => {
  /** Verbatim rawTranscripts from a real history.json, trimmed to the relevant clause. */
  const REAL_HISTORY = [
    'Can we fit Quin three point six twenty seven B on the sixteen gigabyte card',
    'which is good also quinn three point six test',
    'Can you wire it up to the same Quinn three point six model that you are using?',
    'The thinking with llama swapping is to use Gemma 31B as the orchestrator agent'
  ]

  it('finds every spelling the recogniser actually used', () => {
    expect(findMisrecognitions('Qwen', REAL_HISTORY)).toEqual(['quinn', 'quin'])
  })

  it('orders by how often each one appeared', () => {
    // "quinn" twice, "quin" once - the common one is the one worth seeing first.
    expect(findMisrecognitions('Qwen', REAL_HISTORY)[0]).toBe('quinn')
  })

  it('finds ordinary letter-level slips too, not only phonetic ones', () => {
    expect(findMisrecognitions('Kubernetes', ['deploy the Kubernets cluster'])).toEqual([
      'kubernets'
    ])
  })

  it('never proposes the word itself', () => {
    expect(findMisrecognitions('Gemma', ['we are running Gemma today'])).toEqual([])
  })

  it('returns nothing when history has never contained anything like it', () => {
    expect(findMisrecognitions('Qwen', REAL_HISTORY.slice(3))).toEqual([])
    expect(findMisrecognitions('Qwen', [])).toEqual([])
  })

  it('ignores a target too short to match on without coincidence', () => {
    expect(findMisrecognitions('AI', REAL_HISTORY)).toEqual([])
  })
})

describe('formatCorrection', () => {
  it('writes the stored form', () => {
    expect(formatCorrection('quinn', 'Qwen')).toBe('quinn -> Qwen')
  })

  it('trims what the user typed', () => {
    expect(formatCorrection('  quinn ', ' Qwen  ')).toBe('quinn -> Qwen')
  })

  /** A half-filled form is a no-op, not a broken entry with a blank side. */
  it('returns nothing when either side is missing', () => {
    expect(formatCorrection('quinn', '')).toBe('')
    expect(formatCorrection('', 'Qwen')).toBe('')
  })

  /**
   * End to end, this is the reported failure fixed: the user reads "quinn" in
   * their own transcript, says they meant "Qwen", and both spellings stop
   * appearing once the offered follow-up is accepted too.
   */
  it('round-trips through the parser and corrects the text', () => {
    const entries = [formatCorrection('quinn', 'Qwen'), formatCorrection('quin', 'Qwen')]
    const { corrections } = parseVocabulary(entries)
    expect(
      applyVocabularyCorrections('also quinn three point six, and Quin 30B', corrections)
    ).toBe('also Qwen three point six, and Qwen 30B')
  })
})

describe('historyWordSuggestions', () => {
  const HISTORY = [
    'the model is the thing we run',
    'the model quinn is the one',
    'the model handles the parakeet'
  ]

  /**
   * Rarest first, because a word the recogniser mangles is one it does not
   * know - jargon and product names sit at the bottom of a frequency count,
   * while "the" piles up at the top and is never what anyone is fixing.
   */
  it('offers the rare words before the common ones', () => {
    const suggestions = historyWordSuggestions(HISTORY)
    expect(suggestions.indexOf('quinn')).toBeLessThan(suggestions.indexOf('the'))
    expect(suggestions.indexOf('parakeet')).toBeLessThan(suggestions.indexOf('model'))
  })

  it('lists each word once', () => {
    const suggestions = historyWordSuggestions(HISTORY)
    expect(new Set(suggestions).size).toBe(suggestions.length)
  })

  it('handles empty history', () => {
    expect(historyWordSuggestions([])).toEqual([])
  })

  /**
   * Regression: the cap was 300 and the tiebreak alphabetical, so on a real
   * 199-dictation history of 1186 distinct words the list ran out in the a's
   * and "quinn" - the word the feature exists for - could not be suggested at
   * all. Inclusion must never be decided by the cap at a realistic size.
   */
  it('still contains a rare late-alphabet word in a history far larger than any real one', () => {
    const filler = Array.from({ length: 1500 }, (_, i) => `alpha${i} beta${i} gamma${i}`)
    const suggestions = historyWordSuggestions([...filler, 'the quinn model'])
    expect(suggestions).toContain('quinn')
  })
})
