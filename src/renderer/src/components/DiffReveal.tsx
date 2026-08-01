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
 * text. Purely presentational and self-contained: removed words strike
 * through and fade to transparent, inserted/changed words' highlight fades
 * away, and then the gaps the removed words leave behind close up so the
 * text ends the reveal reading exactly like the final cleaned text. All of
 * it is CSS (see DiffReveal.css for the timings), kicked off by the one
 * class toggle below shortly after mount - the parent is responsible for
 * unmounting this once the whole sequence has had time to finish.
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
                {/* The separator lives inside the deleted span, not between
                    the two, so it collapses along with the word it belongs
                    to - see DiffReveal.css. */}
                <span className="diff-reveal__delete">{token.before} </span>
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
