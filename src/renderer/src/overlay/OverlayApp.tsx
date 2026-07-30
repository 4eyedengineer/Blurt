import { useLayoutEffect, useRef } from 'react'
import { useOverlayPushToTalk } from './useOverlayPushToTalk'
import { DiffReveal } from '../components/DiffReveal'
import './OverlayApp.css'

/** Boosted the same way MicLevelMeter boosts its bar - raw RMS reads very small even for healthy speech. */
function levelPercent(level: number): number {
  return Math.max(4, Math.min(100, level * 100 * 5))
}

interface TeleprompterProps {
  /** Changes whenever new content streams in - re-pins the scroll position to the bottom line. */
  updateKey: string
  children: React.ReactNode
}

/**
 * Fixed-height (3 lines) "teleprompter" viewport: text wraps normally and
 * the text block is bottom-anchored via pure CSS (`flex-direction:
 * column-reverse` in OverlayApp.css - see the comment there), so the newest
 * line is always the last one visible and older lines overflow out through
 * the top edge (softened by the fade mask). That anchoring needs no JS at
 * all and is exact by construction - no risk of ending up a few pixels
 * short of "true bottom", unlike an earlier version of this component that
 * pinned `scrollTop = scrollHeight` on a `scroll-behavior: smooth`
 * container: profiling that against this same component found Chromium's
 * smooth-scroll animation reliably undershooting the target by several
 * pixels (e.g. settling at 35px into a 40px scroll range) and staying stuck
 * there, which would have permanently clipped a sliver of the newest line.
 *
 * The only thing left to smooth is the *transition* when new text wraps
 * onto an additional line and everything above shifts up by one
 * line-height - a instant "FLIP": right after the DOM grows, the text
 * block is nudged down by the height delta (with transitions off) so it
 * still *looks* like the old, shorter layout, then on the next animation
 * frame the nudge is released (transition back on) so it eases up to its
 * real (CSS-anchored) resting position over ~120ms. Verified via a
 * standalone harness (see this session's scratchpad) that this settles
 * well under 150ms and monotonically (no springiness) even under
 * continuous ~100ms streaming updates, and that it only engages when the
 * line count actually grows (harmless/no-op on updates that just add
 * characters to the current bottom line).
 */
function Teleprompter({ updateKey, children }: TeleprompterProps): React.JSX.Element {
  const textRef = useRef<HTMLDivElement>(null)
  const prevHeightRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    const el = textRef.current
    if (!el) return
    const prevHeight = prevHeightRef.current
    const newHeight = el.scrollHeight
    if (prevHeight !== null && newHeight > prevHeight) {
      const delta = newHeight - prevHeight
      el.style.transition = 'none'
      el.style.transform = `translateY(${delta}px)`
      void el.offsetHeight // flush so the pre-growth-looking position paints before animating away from it
      requestAnimationFrame(() => {
        el.style.transition = ''
        el.style.transform = ''
      })
    }
    prevHeightRef.current = newHeight
  }, [updateKey])

  return (
    <div className="overlay-app__transcript">
      <div className="overlay-app__transcript-text" ref={textRef}>
        {children}
      </div>
    </div>
  )
}

/**
 * The push-to-talk pill rendered in the separate always-on-top overlay
 * window (see src/main/overlay.ts) - loaded via the `#overlay` hash route,
 * see src/renderer/src/main.tsx. Entirely driven by useOverlayPushToTalk;
 * this component is just presentation.
 */
export function OverlayApp(): React.JSX.Element {
  const {
    phase,
    liveText,
    finalText,
    diffTokens,
    micLevel,
    copied,
    pasted,
    pasteMessage,
    errorMessage
  } = useOverlayPushToTalk()

  if (phase === 'idle') {
    return <div className="overlay-app overlay-app--hidden" />
  }

  return (
    <div className="overlay-app" role="status">
      <span
        className={`overlay-app__dot${phase === 'recording' ? ' overlay-app__dot--pulse' : ''}`}
      />

      <div className="overlay-app__body">
        {phase === 'recording' && (
          <>
            <div className="overlay-app__level-track" aria-hidden="true">
              <div
                className="overlay-app__level-fill"
                style={{ width: `${levelPercent(micLevel)}%` }}
              />
            </div>
            <Teleprompter updateKey={liveText}>{liveText || 'Listening…'}</Teleprompter>
          </>
        )}

        {phase === 'cleaning' && <div className="overlay-app__status">Cleaning up…</div>}

        {phase === 'error' && (
          <div className="overlay-app__status overlay-app__status--error">{errorMessage}</div>
        )}

        {phase === 'revealing' && (
          <Teleprompter updateKey={finalText}>
            <DiffReveal tokens={diffTokens} compact />
          </Teleprompter>
        )}

        {phase === 'done' && (
          <>
            <Teleprompter updateKey={finalText}>{finalText || '(empty)'}</Teleprompter>
            <div
              className={
                !pasted && pasteMessage?.startsWith('Paste failed')
                  ? 'overlay-app__badge overlay-app__badge--error'
                  : 'overlay-app__badge'
              }
            >
              {pasted ? 'Pasted ✓' : (pasteMessage ?? (copied ? 'Copied ✓' : ''))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
