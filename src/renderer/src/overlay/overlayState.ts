/**
 * Pure state machine for the push-to-talk overlay pill. Kept free of React/
 * DOM/IPC so it's trivially unit-testable (see overlayState.test.ts) -
 * useOverlayPushToTalk.ts is the only thing that dispatches into it.
 */
export type OverlayPhase = 'idle' | 'recording' | 'cleaning' | 'done'

export interface OverlayState {
  phase: OverlayPhase
  liveText: string
  finalText: string
  copied: boolean
  pasted: boolean
  pasteMessage: string | null
}

export const initialOverlayState: OverlayState = {
  phase: 'idle',
  liveText: '',
  finalText: '',
  copied: false,
  pasted: false,
  pasteMessage: null
}

export type OverlayAction =
  | { type: 'start' }
  | { type: 'partial'; text: string }
  | { type: 'stop' }
  | { type: 'cancel' }
  | { type: 'cleaned'; text: string }
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
        ? { ...state, phase: 'done', finalText: action.text }
        : state

    case 'paste-status':
      return state.phase === 'done'
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
