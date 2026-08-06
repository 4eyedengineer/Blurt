/**
 * Custom vocabulary, which is two features wearing one settings field.
 *
 * A plain entry ("Kubernetes") is a spelling the cleanup model is told to
 * respect. An entry written `heard -> wanted` ("Quin -> Qwen") is a literal
 * correction applied to the recogniser's output before anything else sees it.
 *
 * The split exists because the two cases fail differently, measured against
 * the real Gemma 4 E2B sidecar on one dictation containing both "Quin" and
 * "Quinn":
 *
 *   hint given to the cleanup model                        result
 *   ----------------------------------------------------  ---------------
 *   (none)                                                 Quin / Quinn
 *   "Spell these terms this way ...: Qwen"                 Quin / Quinn
 *   "... replace any word that looks like a misrecognition" Quin / Quinn
 *   "The recognizer writes Qwen as Quin or Quinn"          Quin / Qwen
 *   "Replace \"Quin\" and \"Quinn\" with \"Qwen\""           Qwen / Qwen
 *
 * Two things follow. A list of *correct* spellings cannot fix a
 * mistranscription at all - "Qwen" never appears in the text, so there is
 * nothing for the model to spell correctly, and the first three rows are all
 * no-ops. And even handed the wrong spelling explicitly, the model corrected
 * one occurrence and missed the other (row four). So corrections are done
 * here, in code, where they cannot be half-applied, and only genuine
 * spelling guidance is spent on prompt budget.
 *
 * Corrections deliberately run against the recogniser's output rather than
 * the cleaned text, so the live transcript shows them too - the term is
 * wrong on screen the whole time you are speaking otherwise.
 */

export interface VocabularyCorrection {
  /** What the recogniser writes. */
  from: string
  /** What it should say instead. */
  to: string
}

export interface ParsedVocabulary {
  /** Plain entries - spelling guidance for the cleanup prompt. */
  spellings: string[]
  /** `from -> to` entries - literal replacements applied to transcripts. */
  corrections: VocabularyCorrection[]
}

const CORRECTION_SEPARATOR = '->'

/**
 * Splits the flat `customVocabulary` string list into its two kinds.
 *
 * Parsing at read time rather than changing the stored shape keeps the
 * setting a `string[]`, so existing entries keep working untouched and there
 * is nothing to migrate. An entry with a separator but a blank side
 * ("-> Qwen", "Quin ->") is dropped rather than guessed at.
 */
export function parseVocabulary(entries: string[] | undefined): ParsedVocabulary {
  const spellings: string[] = []
  const corrections: VocabularyCorrection[] = []

  for (const raw of entries ?? []) {
    const entry = raw.trim()
    if (!entry) continue

    const at = entry.indexOf(CORRECTION_SEPARATOR)
    if (at === -1) {
      spellings.push(entry)
      continue
    }

    const from = entry.slice(0, at).trim()
    const to = entry.slice(at + CORRECTION_SEPARATOR.length).trim()
    if (from && to) corrections.push({ from, to })
  }

  return { spellings, corrections }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Applies every correction to `text` in a single pass.
 *
 * One pass, not one per correction, so a correction can never rewrite what an
 * earlier one just produced - `a -> b` and `b -> c` together must not turn an
 * "a" into a "c". Longest `from` first, so a more specific term wins over one
 * that is a prefix of it.
 *
 * Matching is case-insensitive and word-bounded, and the replacement is used
 * exactly as written: the point of the feature is that the user has decided
 * on the spelling. The boundaries are only applied on a side that actually
 * ends in a word character, so a term like "C++" still matches.
 */
export function applyVocabularyCorrections(
  text: string,
  corrections: VocabularyCorrection[]
): string {
  if (!text || corrections.length === 0) return text

  const ordered = [...corrections].sort((a, b) => b.from.length - a.from.length)
  const lookup = new Map<string, string>()
  for (const { from, to } of ordered) {
    const key = from.toLowerCase()
    // First one wins, so a duplicated `from` behaves predictably rather than
    // depending on which happens to be sorted last.
    if (!lookup.has(key)) lookup.set(key, to)
  }

  const pattern = ordered
    .map(({ from }) => {
      const prefix = /^\w/.test(from) ? '\\b' : ''
      const suffix = /\w$/.test(from) ? '\\b' : ''
      return `${prefix}${escapeRegExp(from)}${suffix}`
    })
    .join('|')

  return text.replace(
    new RegExp(pattern, 'gi'),
    (match) => lookup.get(match.toLowerCase()) ?? match
  )
}
