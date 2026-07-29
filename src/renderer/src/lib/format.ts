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

export function formatDuration(durationMs: number): string {
  const totalSeconds = Math.round(durationMs / 1000)
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return `${minutes}:${seconds.toString().padStart(2, '0')}`
}

export function formatTimestamp(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
