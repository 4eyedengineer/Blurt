import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { BackendStatus } from '@shared/backend'
import type { UseDictationSession } from '../hooks/useDictationSession'

/**
 * The Dictate screen's answer to "the engine isn't usable" - a disabled
 * record button and one short sentence, rather than a live button that
 * fails and then explains itself at length.
 *
 * Held in its own file because it has to mock `useBackendStatus`:
 * `renderToStaticMarkup` never runs effects, so the real hook is stuck on
 * its initial 'starting' value and a 'ready' backend is unreachable from
 * DictateScreen.test.ts.
 */
let status: BackendStatus = { state: 'ready' }
vi.mock('../hooks/useBackendStatus', () => ({ useBackendStatus: () => status }))

const { DictateScreen } = await import('./DictateScreen')

function baseSession(overrides: Partial<UseDictationSession> = {}): UseDictationSession {
  return {
    phase: 'ready',
    liveText: '',
    displayText: 'hello world',
    cleanedText: 'hello world',
    rawTranscript: 'um hello world',
    displayMode: 'none',
    stats: null,
    copyFlash: false,
    sessionError: null,
    micLevel: 0,
    streamPreview: '',
    reveal: null,
    spokenCommand: '',
    canRevert: false,
    showingRaw: false,
    toggleRecording: () => {},
    toggleCommandRecording: () => {},
    applyTransform: async () => {},
    applyVoiceEdit: async () => {},
    revertToCleaned: async () => {},
    toggleShowRaw: () => {},
    copyShownText: async () => true,
    loadFromHistory: () => {},
    startNew: () => {},
    ...overrides
  }
}

function render(overrides: Partial<UseDictationSession> = {}): string {
  return renderToStaticMarkup(createElement(DictateScreen, { session: baseSession(overrides) }))
}

/** The opening `<button ...>` tag carrying this exact aria-label, attributes and all. */
function buttonTagWithAriaLabel(markup: string, label: string): string {
  return new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`).exec(markup)?.[0] ?? ''
}

function recordButtonTag(markup: string): string {
  return buttonTagWithAriaLabel(markup, 'Start recording')
}

beforeEach(() => {
  status = { state: 'ready' }
})

describe('DictateScreen - record button follows the backend', () => {
  it('is live when the engine is ready', () => {
    const tag = recordButtonTag(render({ phase: 'idle' }))
    expect(tag).not.toBe('')
    expect(tag).not.toContain('disabled')
  })

  it('is disabled with no model installed', () => {
    status = { state: 'error', message: 'No model installed.' }
    expect(recordButtonTag(render({ phase: 'idle' }))).toContain('disabled')
  })

  it('is disabled while the engine is still starting', () => {
    status = { state: 'starting' }
    expect(recordButtonTag(render({ phase: 'idle' }))).toContain('disabled')
  })

  /**
   * The one case where an unusable backend must NOT disable the button: it
   * is the Stop button then, and disabling it would strand the user mid-
   * recording with no way to end the session - the exact wedge the disabled
   * state exists to prevent, reintroduced from the other side.
   */
  it('stays live mid-recording even if the engine drops out', () => {
    status = { state: 'error', message: 'The model could not be loaded.' }
    const tag = buttonTagWithAriaLabel(render({ phase: 'recording' }), 'Stop recording')
    expect(tag).not.toBe('')
    expect(tag).not.toContain('disabled')
  })
})

describe('DictateScreen - what an unusable backend says', () => {
  it('shows the short reason, and only that', () => {
    status = { state: 'error', message: 'No model installed.' }
    const markup = render({ phase: 'idle' })
    expect(markup).toContain('No model installed.')
  })

  /**
   * `detail` is the engine's own account of the failure. It belongs in the
   * log and on the status pill's hover title - putting it on screen for
   * every failed action was what made the app feel like it was shouting.
   */
  it('never renders the engine detail behind that reason', () => {
    status = {
      state: 'error',
      message: 'No model installed.',
      detail:
        "The selected model (gemma-4-e2b) isn't downloaded yet - install it from Settings first."
    }
    const markup = render({ phase: 'idle' })
    expect(markup).toContain('No model installed.')
    expect(markup).not.toContain("isn't downloaded yet")
  })

  it('says nothing at all while the engine is merely starting', () => {
    status = { state: 'starting' }
    expect(render({ phase: 'idle' })).not.toContain('dictate-screen__warning')
  })
})

describe('DictateScreen - model-backed controls follow the backend', () => {
  it('disables the transform buttons when the engine is unusable', () => {
    const ready = render()
    status = { state: 'error', message: 'No model installed.' }
    const broken = render()
    // Every transform button is live with a transcript and a ready engine,
    // and none of them are once the engine is gone - they all call the model.
    expect(ready).toContain('<button')
    expect((broken.match(/disabled/g) ?? []).length).toBeGreaterThan(
      (ready.match(/disabled/g) ?? []).length
    )
  })
})
