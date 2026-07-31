/**
 * Dictation stats, shared so the main process (the push-to-talk overlay's
 * history write - see main/overlayController.ts) and the renderer (the
 * Dictate screen's live stats bar) compute them the same way. Pure, no
 * Electron/DOM dependencies.
 */

export function countWords(text: string): number {
  const trimmed = text.trim()
  if (!trimmed) return 0
  return trimmed.split(/\s+/).length
}

export interface SessionStats {
  wordCount: number
  durationMs: number
  wpm: number
}

export function computeStats(text: string, durationMs: number): SessionStats {
  const wordCount = countWords(text)
  const minutes = Math.max(durationMs / 60000, 1 / 60) // floor at 1s to avoid divide-by-near-zero spikes
  const wpm = Math.round(wordCount / minutes)
  return { wordCount, durationMs, wpm }
}
