/**
 * Pure word-level diff between a "before" and "after" text, used to render
 * the brief inline diff-reveal shown when the cleanup pass (and, more
 * cheaply, voice-edit) replaces text - see DiffReveal.tsx and
 * useDictationSession's/useOverlayPushToTalk's use of it. No DOM/React here
 * so it's trivial to unit test - see wordDiff.test.ts.
 *
 * Algorithm: classic LCS (longest common subsequence) over whitespace-
 * tokenized words, matched case-insensitively and with punctuation stripped
 * (`coreKey`) so a word that only gained/lost punctuation or changed case
 * still aligns to "the same word" instead of showing as a spurious
 * delete+insert pair. Two aligned tokens are then classified:
 *   - 'equal' if they're identical ignoring case (casing-only differences
 *     are not meaningful content changes - the cleanup pass fixing
 *     capitalization shouldn't be flagged as a change)
 *   - 'replace' if they differ only in punctuation (per the task spec:
 *     "treat punctuation-only differences as replacements")
 * Tokens with no counterpart in the other text are 'delete' (before-only)
 * or 'insert' (after-only) - this is what makes an actually-different word
 * (not just re-punctuated) show up as an adjacent delete+insert pair rather
 * than a same-position replace, matching how most word-diff tools render a
 * wholesale word swap.
 */
export type DiffOp = 'equal' | 'delete' | 'insert' | 'replace'

export interface DiffToken {
  op: DiffOp
  /** Original-cased token from `before` - present for 'equal' | 'delete' | 'replace'. */
  before?: string
  /** Original-cased token from `after` - present for 'equal' | 'insert' | 'replace'. */
  after?: string
}

function tokenize(text: string): string[] {
  const trimmed = text.trim()
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/)
}

/** Lowercased, punctuation-stripped comparison key used to align tokens across the two texts. */
function coreKey(word: string): string {
  return word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Word-level diff of `before` -> `after`. Returns a flat sequence of tokens
 * in reading order (interleaving equal/delete/insert/replace) that, read in
 * order, reconstructs both texts.
 */
export function diffWords(before: string, after: string): DiffToken[] {
  const beforeWords = tokenize(before)
  const afterWords = tokenize(after)
  const n = beforeWords.length
  const m = afterWords.length

  if (n === 0 && m === 0) return []

  const beforeKeys = beforeWords.map(coreKey)
  const afterKeys = afterWords.map(coreKey)

  // dp[i][j] = length of the LCS (by coreKey equality) of beforeWords[i:] and afterWords[j:].
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] =
        beforeKeys[i] === afterKeys[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const tokens: DiffToken[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (beforeKeys[i] === afterKeys[j]) {
      const b = beforeWords[i]
      const a = afterWords[j]
      tokens.push(
        b.toLowerCase() === a.toLowerCase()
          ? { op: 'equal', before: b, after: a }
          : { op: 'replace', before: b, after: a }
      )
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      tokens.push({ op: 'delete', before: beforeWords[i] })
      i++
    } else {
      tokens.push({ op: 'insert', after: afterWords[j] })
      j++
    }
  }
  while (i < n) {
    tokens.push({ op: 'delete', before: beforeWords[i] })
    i++
  }
  while (j < m) {
    tokens.push({ op: 'insert', after: afterWords[j] })
    j++
  }

  return tokens
}
