import type { TransformMode } from '../../shared/backend'

const FILLER_WORDS = new Set(['um', 'uh', 'erm', 'hmm', 'uhh', 'umm'])

/**
 * Mock "cleanup pass": strips filler words and fixes capitalization/
 * punctuation on raw (typically all-lowercase, unpunctuated) ASR output.
 */
export function cleanupText(raw: string): string {
  const words = raw
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !FILLER_WORDS.has(w.toLowerCase().replace(/[^a-z']/g, '')))

  if (words.length === 0) return ''

  let joined = words.join(' ')

  // Capitalize standalone "i"
  joined = joined.replace(/\bi\b/g, 'I')

  // Capitalize first letter
  joined = joined.charAt(0).toUpperCase() + joined.slice(1)

  // Ensure terminal punctuation
  if (!/[.!?]$/.test(joined)) {
    joined += '.'
  }

  return joined
}

function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

function countWords(text: string): number {
  return text.trim().length === 0 ? 0 : text.trim().split(/\s+/).length
}

const FORMAL_REPLACEMENTS: Array<[RegExp, string]> = [
  [/\bI'm\b/gi, 'I am'],
  [/\bcan't\b/gi, 'cannot'],
  [/\bdon't\b/gi, 'do not'],
  [/\bdoesn't\b/gi, 'does not'],
  [/\bdidn't\b/gi, 'did not'],
  [/\bwon't\b/gi, 'will not'],
  [/\bit's\b/gi, 'it is'],
  [/\bthat's\b/gi, 'that is'],
  [/\bthere's\b/gi, 'there is'],
  [/\bwe're\b/gi, 'we are'],
  [/\bthey're\b/gi, 'they are'],
  [/\bgonna\b/gi, 'going to'],
  [/\bwanna\b/gi, 'want to'],
  [/\bkinda\b/gi, 'somewhat'],
  [/\bstuff\b/gi, 'matters'],
  [/\bthanks\b/gi, 'thank you'],
  [/\bguys\b/gi, 'everyone'],
  [/\bgreat news\b/gi, 'a positive development']
]

function toFormal(text: string): string {
  let result = text
  for (const [pattern, replacement] of FORMAL_REPLACEMENTS) {
    result = result.replace(pattern, replacement)
  }
  return result
}

function toKeyPoints(text: string): string {
  const sentences = splitSentences(text)
  const source = sentences.length > 0 ? sentences : [text]
  return source.map((s) => `• ${s.replace(/[.!?]+$/, '')}`).join('\n')
}

function toShort(text: string): string {
  const sentences = splitSentences(text)
  if (sentences.length <= 1) {
    const words = text.split(/\s+/)
    const keep = Math.max(6, Math.ceil(words.length * 0.5))
    const truncated = words.slice(0, keep).join(' ')
    return /[.!?]$/.test(truncated) ? truncated : `${truncated}.`
  }
  const keep = Math.max(1, Math.ceil(sentences.length * 0.5))
  return sentences.slice(0, keep).join(' ')
}

function toLong(text: string): string {
  const sentences = splitSentences(text)
  const first = sentences[0] ?? text
  const elaboration = [
    text,
    `In other words, ${lowerFirst(first)}`,
    `This matters because it directly affects the team's next steps and should be tracked accordingly.`
  ]
  return elaboration.join(' ')
}

function lowerFirst(s: string): string {
  const trimmed = s.trim().replace(/[.!?]+$/, '')
  return trimmed.charAt(0).toLowerCase() + trimmed.slice(1) + '.'
}

export function transformText(text: string, mode: TransformMode): string {
  switch (mode) {
    case 'keypoints':
      return toKeyPoints(text)
    case 'formal':
      return toFormal(text)
    case 'short':
      return toShort(text)
    case 'long':
      return toLong(text)
    default:
      return text
  }
}

/**
 * Mock "voice edit" command handler. Understands a small set of patterns;
 * anything unrecognized is returned unchanged. A real backend would route
 * this through the LLM for open-ended natural-language edits.
 */
export function applyVoiceEdit(text: string, command: string): string {
  const cmd = command.trim().toLowerCase()

  const replaceMatch = cmd.match(/^replace\s+(.+?)\s+with\s+(.+)$/i)
  if (replaceMatch) {
    const [, from, to] = replaceMatch
    const pattern = new RegExp(escapeRegExp(from), 'ig')
    return text.replace(pattern, to)
  }

  if (/^delete (the )?last sentence$/.test(cmd)) {
    const sentences = splitSentences(text)
    sentences.pop()
    return sentences.join(' ')
  }

  if (/^delete (the )?first sentence$/.test(cmd)) {
    const sentences = splitSentences(text)
    sentences.shift()
    return sentences.join(' ')
  }

  if (/^(uppercase|capitalize) (everything|all)$/.test(cmd)) {
    return text.toUpperCase()
  }

  if (/^add (a )?period$/.test(cmd) && !/[.!?]$/.test(text.trim())) {
    return `${text.trim()}.`
  }

  // Unrecognized command: no-op, return the text unchanged.
  return text
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export { countWords }
