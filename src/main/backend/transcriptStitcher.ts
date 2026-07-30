/**
 * Pure text-stitching helper for `LitertBackend`'s rolling-window partial
 * ticks (see litertBackend.ts's window/commit logic in `runPartialTranscription`).
 *
 * Each partial tick only re-transcribes a bounded trailing slice of audio
 * (not the whole session, see `DEFAULT_PARTIAL_WINDOW_MS`), and that slice
 * deliberately starts a little *before* the point where already-committed
 * text ends (`DEFAULT_PARTIAL_WINDOW_OVERLAP_MS` of overlap) so a word
 * cut off at the committed boundary gets a full second chance to be heard
 * whole. That means the window's own transcript typically starts by
 * re-saying the tail end of `committedText` - `stitchTranscript` finds that
 * repeated tail (word-boundary matching, not raw substring matching, since
 * the two transcriptions are independent model calls and won't necessarily
 * agree on punctuation/case at the seam) and drops it so the displayed text
 * doesn't visibly duplicate words.
 *
 * This is inherently a live-display approximation - unlike `endSession`'s
 * single full-buffer final pass (see litertBackend.ts), there is no
 * guarantee the seam is clean. Seam flicker/artifacts are an accepted
 * tradeoff for keeping partial-tick cost flat regardless of session length
 * (see scratchpad/perf-review.md §2b).
 */

/** Strips leading/trailing non-alphanumeric characters and lowercases, for tolerant word-boundary comparison. */
function normalizeWord(word: string): string {
  return word.toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, '')
}

function splitWords(text: string): string[] {
  const trimmed = text.trim()
  return trimmed.length === 0 ? [] : trimmed.split(/\s+/)
}

/**
 * Merges `committedText` (already-finalized text from earlier windows) with
 * `windowText` (the raw, possibly-still-streaming transcript of the current
 * rolling window, which was asked to re-cover a little already-committed
 * audio for overlap). Returns the full display text - callers show the
 * return value directly, they never need to append it to anything else.
 *
 * Algorithm: find the longest run of words at the end of `committedText`
 * that also appears at the start of `windowText` (case-insensitive,
 * punctuation-insensitive) and drop that duplicated run from the window's
 * side before appending. Falls back to a plain concatenation when no
 * word-level overlap is found, and additionally handles the case where the
 * committed text's last word is itself a truncated *prefix* of the window's
 * first word (e.g. the committed window ended mid-word) by preferring the
 * window's presumably-complete version of that word.
 */
export function stitchTranscript(committedText: string, windowText: string): string {
  const committed = committedText.trim()
  const window = windowText.trim()
  if (!committed) return window
  if (!window) return committed

  const committedWords = splitWords(committed)
  const windowWords = splitWords(window)

  const maxOverlap = Math.min(committedWords.length, windowWords.length)
  let overlap = 0
  for (let k = maxOverlap; k >= 1; k--) {
    let matches = true
    for (let i = 0; i < k; i++) {
      const committedWord = normalizeWord(committedWords[committedWords.length - k + i])
      const windowWord = normalizeWord(windowWords[i])
      if (committedWord !== windowWord) {
        matches = false
        break
      }
    }
    if (matches) {
      overlap = k
      break
    }
  }

  if (overlap === 0) {
    // No whole-word overlap - check for the "cut mid-word at the seam"
    // case: committed's last word may be a truncated prefix of window's
    // first (now complete) word. If so, prefer the window's version of
    // that one word rather than showing both the truncated and complete
    // forms back to back.
    const lastCommitted = normalizeWord(committedWords[committedWords.length - 1] ?? '')
    const firstWindow = normalizeWord(windowWords[0] ?? '')
    if (
      // Require at least 2 characters so real (short) words like "a"/"I"/
      // "to" - which are legitimately prefixes of many other words - don't
      // get misidentified as truncated mid-word cuts.
      lastCommitted.length > 1 &&
      firstWindow.length > lastCommitted.length &&
      firstWindow.startsWith(lastCommitted)
    ) {
      const withoutTruncatedWord = committedWords.slice(0, -1).join(' ')
      const rest = windowWords.join(' ')
      return withoutTruncatedWord ? `${withoutTruncatedWord} ${rest}` : rest
    }

    return `${committedWords.join(' ')} ${windowWords.join(' ')}`
  }

  const committedJoined = committedWords.join(' ')
  const remainder = windowWords.slice(overlap).join(' ')
  return remainder ? `${committedJoined} ${remainder}` : committedJoined
}
