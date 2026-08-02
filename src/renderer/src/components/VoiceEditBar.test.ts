import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { VoiceEditBar } from './VoiceEditBar'

/**
 * The edit instruction can be spoken as well as typed, and the recognized
 * wording is deliberately shown in the input for confirmation rather than
 * applied straight away - a misheard instruction rewrites the user's
 * transcript with no way back. These cover the wiring that makes that
 * confirmation step actually happen, which is invisible by reading the JSX
 * (it is a during-render sync, not an effect) and easy to break.
 */
function render(props: Partial<Parameters<typeof VoiceEditBar>[0]> = {}): string {
  return renderToStaticMarkup(createElement(VoiceEditBar, { onApply: () => {}, ...props }))
}

/** The `value` React renders onto the text input, i.e. what the user would see in the box. */
function inputValue(markup: string): string {
  return /<input[^>]*\bvalue="([^"]*)"/.exec(markup)?.[1] ?? ''
}

describe('VoiceEditBar', () => {
  it('shows a recognized spoken instruction in the input rather than applying it', () => {
    expect(inputValue(render({ spokenCommand: 'delete the last sentence' }))).toBe(
      'delete the last sentence'
    )
  })

  it('leaves the input empty when nothing has been spoken', () => {
    expect(inputValue(render())).toBe('')
    expect(inputValue(render({ spokenCommand: '' }))).toBe('')
  })

  it('offers a mic button only when speaking is wired up', () => {
    expect(render({ onToggleRecording: () => {} })).toContain('voice-edit-bar__mic')
    // No handler means no way to speak, so the affordance must not appear at
    // all rather than render a dead button.
    expect(render()).not.toContain('voice-edit-bar__mic')
  })

  it('offers to stop, not start, while it is listening', () => {
    const markup = render({ onToggleRecording: () => {}, recording: true })
    expect(markup).toContain('aria-label="Stop listening"')
    expect(markup).toContain('aria-pressed="true"')
    expect(markup).toContain('voice-edit-bar__mic--recording')
  })

  it('offers to start listening when idle', () => {
    const markup = render({ onToggleRecording: () => {} })
    expect(markup).toContain('aria-label="Speak the edit instruction"')
    expect(markup).toContain('aria-pressed="false"')
    expect(markup).not.toContain('voice-edit-bar__mic--recording')
  })

  it('keeps the mic and the input live while recording, even though the bar is disabled', () => {
    // The parent disables the bar during a rewrite, but while listening the
    // user must still be able to stop, and to fix a half-heard instruction
    // by hand. A blanket `disabled` here would strand them mid-recording.
    const markup = render({ onToggleRecording: () => {}, disabled: true, recording: true })
    const inputTag = /<input[^>]*>/.exec(markup)?.[0] ?? ''
    const micTag = /<button[^>]*voice-edit-bar__mic[^>]*>/.exec(markup)?.[0] ?? ''
    expect(inputTag).not.toContain('disabled')
    expect(micTag).not.toContain('disabled')
  })

  it('disables the mic when the bar is disabled and not recording', () => {
    const micTag =
      /<button[^>]*voice-edit-bar__mic[^>]*>/.exec(
        render({ onToggleRecording: () => {}, disabled: true })
      )?.[0] ?? ''
    expect(micTag).toContain('disabled')
  })
})
