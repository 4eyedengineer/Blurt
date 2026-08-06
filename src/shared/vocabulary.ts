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
 *
 * Nobody types the left-hand side. Asking a user which misspellings to
 * enumerate is asking them to predict a speech recogniser, and it fails the
 * first time out: an entry of `Quin -> Qwen` did nothing for a dictation that
 * came back "quinn", because word-bounded matching (correctly) will not fire
 * inside a longer word. `findMisrecognitions` is the answer - the app already
 * has every raw transcript it has ever produced, so it can look up what it
 * actually wrote instead of asking.
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

// ---------------------------------------------------------------------------
// Finding what the recogniser actually wrote
// ---------------------------------------------------------------------------

/** Words shorter than this are too common and too easily coincidental to propose. */
const MIN_CANDIDATE_LENGTH = 3
/** Cap on how many misrecognitions one word can pull in, so a noisy match can't flood the list. */
const MAX_CANDIDATES = 6

/**
 * Soundex, the 1918 census algorithm: a letter plus three digits, equal for
 * words that sound alike.
 *
 * This is the load-bearing matcher, and edit distance cannot replace it.
 * "Qwen" to "quinn" is three edits on a four-letter word - further apart than
 * any threshold could safely allow - because the recogniser's mistakes are
 * phonetic rather than orthographic. It heard a sound and chose a plausible
 * spelling. Soundex puts both at Q500 and finds it immediately.
 *
 * Deliberately the coarse version rather than something like Metaphone, which
 * is more precise and gets this exact case wrong: Metaphone folds the "qu" in
 * "quin" to a K and separates it from "Qwen". Coarseness is affordable here
 * because candidates can only ever be words the user has really dictated, and
 * every match it proposes is visible and removable afterwards.
 */
export function soundex(word: string): string {
  const letters = word.toUpperCase().replace(/[^A-Z]/g, '')
  if (!letters) return ''

  const code = (letter: string): string => {
    if ('BFPV'.includes(letter)) return '1'
    if ('CGJKQSXZ'.includes(letter)) return '2'
    if ('DT'.includes(letter)) return '3'
    if (letter === 'L') return '4'
    if ('MN'.includes(letter)) return '5'
    if (letter === 'R') return '6'
    return ''
  }

  let out = letters[0]
  let previous = code(letters[0])
  for (const letter of letters.slice(1)) {
    const digit = code(letter)
    // Same-coded letters in a row collapse to one, and H/W do not break that
    // run, while a vowel does - so "quinn" is Q5, not Q55.
    if (digit && digit !== previous) out += digit
    if (!'HW'.includes(letter)) previous = digit
    if (out.length === 4) break
  }
  return out.padEnd(4, '0')
}

/** Levenshtein distance, iterative single-row. Complements soundex for ordinary letter-level slips. */
export function editDistance(a: string, b: string): number {
  const s = a.toLowerCase()
  const t = b.toLowerCase()
  let previous = Array.from({ length: t.length + 1 }, (_, i) => i)
  for (let i = 1; i <= s.length; i++) {
    const current = [i]
    for (let j = 1; j <= t.length; j++) {
      current[j] = Math.min(
        previous[j] + 1,
        current[j - 1] + 1,
        previous[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1)
      )
    }
    previous = current
  }
  return previous[t.length]
}

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? []
}

/**
 * Every distinct word in `transcripts` that looks like the recogniser's
 * attempt at `target`, most frequent first.
 *
 * `transcripts` must be RAW transcripts, not cleaned text: cleanup capitalizes
 * and reflows, and what matters here is exactly what the recogniser emitted.
 *
 * The matcher is deliberately generous - either a soundex hit or a small
 * edit distance qualifies - because it is proposing from a closed set of
 * words the user has genuinely said, not deciding anything at transcription
 * time. A coincidence costs one click to remove; a miss costs the whole
 * feature, which is the failure this replaces.
 */
export function findMisrecognitions(target: string, transcripts: string[]): string[] {
  const wanted = target.trim().toLowerCase()
  if (wanted.length < MIN_CANDIDATE_LENGTH) return []

  const wantedSoundex = soundex(wanted)
  // Scaled to the word, so a long term tolerates more slippage than a short
  // one where two edits could reach an unrelated word entirely.
  const maxEdits = Math.max(1, Math.floor(wanted.length / 4))

  const counts = new Map<string, number>()
  for (const transcript of transcripts) {
    for (const token of tokenize(transcript)) {
      if (token === wanted || token.length < MIN_CANDIDATE_LENGTH) continue
      const matches =
        (wantedSoundex !== '' && soundex(token) === wantedSoundex) ||
        editDistance(token, wanted) <= maxEdits
      if (matches) counts.set(token, (counts.get(token) ?? 0) + 1)
    }
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_CANDIDATES)
    .map(([token]) => token)
}

/**
 * The vocabulary entries to store for `word`: the spelling itself, plus one
 * correction per misrecognition found.
 *
 * Returns entries in the stored `string[]` form rather than a richer type, so
 * what the user ends up seeing in Settings is exactly what is written to
 * disk - a correction that misfires can be deleted like any other entry,
 * without needing UI that knows it was generated rather than typed.
 */
export function buildVocabularyEntries(word: string, misrecognitions: string[]): string[] {
  const wanted = word.trim()
  if (!wanted) return []
  return [wanted, ...misrecognitions.map((heard) => `${heard} ${CORRECTION_SEPARATOR} ${wanted}`)]
}
