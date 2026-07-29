/**
 * Pure state machine for the push-to-talk overlay pill. Kept free of React/
 * DOM/IPC so it's trivially unit-testable (see overlayState.test.ts) -
 * useOverlayPushToTalk.ts is the only thing that dispatches into it.
 */
import { diffWords, type DiffToken } from '../lib/wordDiff'

export type OverlayPhase = 'idle' | 'recording' | 'cleaning' | 'revealing' | 'done'

export interface OverlayState {
  phase: OverlayPhase
  liveText: string
  finalText: string
  /** Word-diff of raw -> cleaned text, populated once cleanup finishes; rendered only during 'revealing'. */
  diffTokens: DiffToken[]
  copied: boolean
  pasted: boolean
  pasteMessage: string | null
}

export const initialOverlayState: OverlayState = {
  phase: 'idle',
  liveText: '',
  finalText: '',
  diffTokens: [],
  copied: false,
  pasted: false,
  pasteMessage: null
}

export type OverlayAction =
  | { type: 'start' }
  | { type: 'partial'; text: string }
  | { type: 'stop' }
  | { type: 'cancel' }
  /** Cleanup finished - `raw` is the pre-cleanup transcript, used to compute the brief diff-reveal. */
  | { type: 'cleaned'; raw: string; text: string }
  /** The diff-reveal window has elapsed - settle to the plain final text. */
  | { type: 'settle' }
  | { type: 'paste-status'; copied: boolean; pasted: boolean; message: string | null }
  | { type: 'reset' }

/**
 * Valid transitions only - anything that doesn't make sense for the current
 * phase (e.g. a stray 'partial' after 'stop' already fired) is a no-op
 * rather than corrupting state, since IPC delivery order edge cases (a
 * late-arriving partial transcript, a duplicate cancel) shouldn't be able to
 * wedge the overlay in a broken visual state.
 */
export function overlayReducer(state: OverlayState, action: OverlayAction): OverlayState {
  switch (action.type) {
    case 'start':
      return { ...initialOverlayState, phase: 'recording' }

    case 'partial':
      return state.phase === 'recording' ? { ...state, liveText: action.text } : state

    case 'stop':
      return state.phase === 'recording' ? { ...state, phase: 'cleaning' } : state

    case 'cleaned':
      return state.phase === 'cleaning'
        ? {
            ...state,
            phase: 'revealing',
            finalText: action.text,
            diffTokens: diffWords(action.raw, action.text)
          }
        : state

    case 'settle':
      return state.phase === 'revealing' ? { ...state, phase: 'done' } : state

    case 'paste-status':
      // The clipboard copy/paste happens immediately on cleanup completion
      // (see useOverlayPushToTalk) - its result can arrive while we're still
      // in 'revealing', ahead of the diff-reveal settling to 'done'.
      return state.phase === 'done' || state.phase === 'revealing'
        ? {
            ...state,
            copied: action.copied,
            pasted: action.pasted,
            pasteMessage: action.message
          }
        : state

    case 'cancel':
      return state.phase === 'idle' ? state : { ...initialOverlayState }

    case 'reset':
      return state.phase === 'idle' ? state : { ...initialOverlayState }

    default:
      return state
  }
}
