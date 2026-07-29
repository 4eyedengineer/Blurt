import { useEffect, useState } from 'react'
import type { DiffToken } from '../lib/wordDiff'
import './DiffReveal.css'

export interface DiffRevealProps {
  tokens: DiffToken[]
  /** Tighter single-line styling + a shorter settle transition, for the push-to-talk overlay pill. */
  compact?: boolean
}

/** Delay before the CSS "settling" class is added, so the browser paints the initial (unfaded) state first. */
const SETTLE_START_DELAY_MS = 60

/**
 * Inline word-diff view shown briefly between "raw transcript" and "cleaned
 * text" once a cleanup (or voice-edit) pass finishes - see
 * useDictationSession/DictateScreen and useOverlayPushToTalk/OverlayApp for
 * how long each keeps this mounted before swapping to the plain settled
 * text. Purely presentational and self-contained: removed words fade to
 * transparent (with a strikethrough) and inserted/changed words' highlight
 * fades away, both via a CSS transition kicked off shortly after mount -
 * the parent is responsible for unmounting this once the fade has had time
 * to finish.
 */
export function DiffReveal({ tokens, compact = false }: DiffRevealProps): React.JSX.Element {
  const [settling, setSettling] = useState(false)

  useEffect(() => {
    const timer = setTimeout(() => setSettling(true), SETTLE_START_DELAY_MS)
    return () => clearTimeout(timer)
  }, [])

  const className = [
    'diff-reveal',
    compact && 'diff-reveal--compact',
    settling && 'diff-reveal--settling'
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span className={className}>
      {tokens.map((token, index) => {
        switch (token.op) {
          case 'equal':
            return <span key={index}>{token.after ?? token.before} </span>
          case 'delete':
            return (
              <span key={index} className="diff-reveal__delete">
                {token.before}{' '}
              </span>
            )
          case 'insert':
            return (
              <span key={index} className="diff-reveal__insert">
                {token.after}{' '}
              </span>
            )
          case 'replace':
            return (
              <span key={index}>
                <span className="diff-reveal__delete">{token.before}</span>{' '}
                <span className="diff-reveal__insert">{token.after}</span>{' '}
              </span>
            )
          default:
            return null
        }
      })}
    </span>
  )
}
