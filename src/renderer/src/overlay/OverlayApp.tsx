import { useLayoutEffect, useRef } from 'react'
import { useOverlayPushToTalk } from './useOverlayPushToTalk'
import { DiffReveal } from '../components/DiffReveal'
import './OverlayApp.css'

/** Boosted the same way MicLevelMeter boosts its bar - raw RMS reads very small even for healthy speech. */
function levelPercent(level: number): number {
  return Math.max(4, Math.min(100, level * 100 * 5))
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
  const transcriptRef = useRef<HTMLDivElement>(null)

  // "truncate left, newest visible": keep the live transcript scrolled to
  // its own right edge as it grows, so the most recently recognized words
  // stay on screen instead of the (by-now-irrelevant) start of the phrase.
  useLayoutEffect(() => {
    const el = transcriptRef.current
    if (el) el.scrollLeft = el.scrollWidth
  }, [liveText])

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
            <div className="overlay-app__transcript" ref={transcriptRef}>
              {liveText || 'Listening…'}
            </div>
          </>
        )}

        {phase === 'cleaning' && <div className="overlay-app__status">Cleaning up…</div>}

        {phase === 'error' && (
          <div className="overlay-app__status overlay-app__status--error">{errorMessage}</div>
        )}

        {phase === 'revealing' && (
          <div className="overlay-app__transcript overlay-app__transcript--final">
            <DiffReveal tokens={diffTokens} compact />
          </div>
        )}

        {phase === 'done' && (
          <>
            <div className="overlay-app__transcript overlay-app__transcript--final">
              {finalText || '(empty)'}
            </div>
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
