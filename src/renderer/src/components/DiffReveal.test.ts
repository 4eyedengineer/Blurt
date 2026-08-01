import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DiffReveal } from './DiffReveal'
import type { DiffToken } from '../lib/wordDiff'

/**
 * Guards the one detail that makes the reveal's collapse land on correctly
 * spaced text: each removed word must carry its trailing separator *inside*
 * its own span, so the space collapses along with the word. Put the space
 * between the spans instead and it survives the collapse, leaving a double
 * space where the removed word used to be. It is a single invisible
 * character, easy to lose to a reformat, and impossible to notice by
 * reading the JSX - hence this test rather than a comment alone.
 */
function render(tokens: DiffToken[]): string {
  return renderToStaticMarkup(createElement(DiffReveal, { tokens }))
}

/** The markup with every removed word dropped, i.e. how the reveal reads once it has settled. */
function textAfterCollapse(tokens: DiffToken[]): string {
  return render(tokens)
    .replace(/<span class="diff-reveal__delete">.*?<\/span>/g, '')
    .replace(/<[^>]+>/g, '')
}

const SENTENCE: DiffToken[] = [
  { op: 'equal', before: 'hello', after: 'hello' },
  { op: 'delete', before: 'um' },
  { op: 'replace', before: 'quick', after: 'fast' },
  { op: 'insert', after: 'brown' },
  { op: 'equal', before: 'world', after: 'world' }
]

describe('DiffReveal', () => {
  it('keeps a deleted word and its separator in one collapsing span', () => {
    expect(render([{ op: 'delete', before: 'um' }])).toContain(
      '<span class="diff-reveal__delete">um </span>'
    )
  })

  it('keeps the separator inside the deleted half of a replacement, not between the halves', () => {
    const html = render([{ op: 'replace', before: 'quick', after: 'fast' }])
    expect(html).toContain('<span class="diff-reveal__delete">quick </span>')
    expect(html).not.toContain('</span> <span class="diff-reveal__insert">')
  })

  it('reads as the cleaned sentence once the removed words collapse away', () => {
    expect(textAfterCollapse(SENTENCE).trim()).toBe('hello fast brown world')
  })

  it('shows every original word before anything collapses', () => {
    expect(
      render(SENTENCE)
        .replace(/<[^>]+>/g, '')
        .trim()
    ).toBe('hello um quick fast brown world')
  })
})
