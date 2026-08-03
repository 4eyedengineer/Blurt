import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DictateScreen } from './DictateScreen'
import type { UseDictationSession } from '../hooks/useDictationSession'

/**
 * Covers the way back to the original text: the Revert button and the
 * Show original/Show edited toggle in the transcript toolbar, and the
 * toolbar label / transcript body swapping to the raw transcript while
 * showingRaw is on. DictateScreen trusts `canRevert` as given by the
 * session (its derivation is covered separately by
 * useDictationSession.test.ts's `computeCanRevert` tests) - what's tested
 * here is DictateScreen's own rendering logic: whether it shows/labels/
 * disables these controls correctly for a given session snapshot.
 */
function baseSession(overrides: Partial<UseDictationSession> = {}): UseDictationSession {
  return {
    phase: 'ready',
    liveText: '',
    displayText: '- hello\n- world',
    cleanedText: 'hello world',
    rawTranscript: 'um hello world',
    displayMode: 'keypoints',
    stats: null,
    copyFlash: false,
    sessionError: null,
    micLevel: 0,
    streamPreview: '',
    reveal: null,
    spokenCommand: '',
    canRevert: true,
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

/** The opening `<button ...>` tag for the button carrying this exact aria-label, attributes and all. Empty string if no such button was rendered. */
function buttonTagWithAriaLabel(markup: string, label: string): string {
  const re = new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`)
  return re.exec(markup)?.[0] ?? ''
}

/** Text of the transcript-toolbar's label span ("Transcript" / "Live transcript" / "Original transcript"). */
function toolbarLabel(markup: string): string {
  const idx = markup.indexOf('dictate-screen__transcript-toolbar')
  if (idx < 0) return ''
  return /<span>([^<]*)<\/span>/.exec(markup.slice(idx))?.[1] ?? ''
}

/**
 * Plain-text content of the transcript body div specifically - not the
 * -wrap container or -toolbar div, both of which share the same prefix. The
 * lookahead requires the class token to end right there (a quote, or a
 * space before a --empty/--busy modifier), which a hyphen-continued class
 * like "...transcript-wrap" or "...transcript-toolbar" does not satisfy.
 */
function transcriptBodyText(markup: string): string {
  const m = /<div class="dictate-screen__transcript(?=["\s])[^"]*">([\s\S]*?)<\/div>/.exec(markup)
  return m ? m[1].replace(/<[^>]+>/g, '') : ''
}

describe('DictateScreen - revert', () => {
  it('offers Revert, labeled and described as specified, when the session says canRevert', () => {
    const markup = render({ canRevert: true })
    expect(markup).toContain('>Revert<')
    const tag = buttonTagWithAriaLabel(markup, 'Revert to the original cleaned text')
    expect(tag).not.toBe('')
    expect(tag).toContain('title="Revert to the original cleaned text"')
  })

  it('is not rendered at all when the session says canRevert is false', () => {
    const markup = render({ canRevert: false })
    expect(buttonTagWithAriaLabel(markup, 'Revert to the original cleaned text')).toBe('')
    expect(markup).not.toContain('>Revert<')
  })

  it('is disabled while recording, mid-command-recording, or busy, even though canRevert is true', () => {
    for (const phase of ['recording', 'command-recording', 'transforming'] as const) {
      const tag = buttonTagWithAriaLabel(
        render({ canRevert: true, phase }),
        'Revert to the original cleaned text'
      )
      expect(tag).toContain('disabled')
    }
  })

  it('is enabled once settled back to ready', () => {
    const tag = buttonTagWithAriaLabel(
      render({ canRevert: true, phase: 'ready' }),
      'Revert to the original cleaned text'
    )
    expect(tag).not.toContain('disabled')
  })
})

describe('DictateScreen - show original toggle', () => {
  it('is not offered before any raw transcript has been captured', () => {
    const markup = render({ rawTranscript: '', displayText: 'hello world' })
    expect(markup).not.toContain('Show original')
  })

  it('is not offered when the raw transcript is identical to what is displayed', () => {
    const markup = render({ rawTranscript: 'hello world', displayText: 'hello world' })
    expect(markup).not.toContain('Show original')
  })

  it('labels itself "Show original" when not currently showing the original', () => {
    const markup = render({ showingRaw: false })
    expect(markup).toContain('>Show original<')
    expect(buttonTagWithAriaLabel(markup, 'Show the original transcript')).not.toBe('')
  })

  it('labels itself "Show edited" while showing the original', () => {
    const markup = render({ showingRaw: true })
    expect(markup).toContain('>Show edited<')
    expect(buttonTagWithAriaLabel(markup, 'Show the edited transcript')).not.toBe('')
  })

  it('is disabled while recording, mid-command-recording, or busy', () => {
    for (const phase of ['recording', 'command-recording', 'editing'] as const) {
      const tag = buttonTagWithAriaLabel(render({ phase }), 'Show the original transcript')
      expect(tag).toContain('disabled')
    }
  })
})

describe('DictateScreen - toolbar label and transcript body', () => {
  it('reads "Transcript" at rest', () => {
    expect(toolbarLabel(render({ phase: 'ready', showingRaw: false }))).toBe('Transcript')
  })

  it('reads "Live transcript" while recording', () => {
    expect(toolbarLabel(render({ phase: 'recording', showingRaw: false }))).toBe('Live transcript')
  })

  it('reads "Original transcript" while showing the original', () => {
    expect(toolbarLabel(render({ showingRaw: true }))).toBe('Original transcript')
  })

  it('renders displayText, not rawTranscript, when not showing the original', () => {
    const body = transcriptBodyText(
      render({ showingRaw: false, displayText: 'edited text', rawTranscript: 'raw text' })
    )
    expect(body).toContain('edited text')
    expect(body).not.toContain('raw text')
  })

  it('renders rawTranscript, not displayText, while showing the original', () => {
    const body = transcriptBodyText(
      render({ showingRaw: true, displayText: 'edited text', rawTranscript: 'raw text' })
    )
    expect(body).toContain('raw text')
    expect(body).not.toContain('edited text')
  })
})
