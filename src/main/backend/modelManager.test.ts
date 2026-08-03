import { describe, expect, it } from 'vitest'
import { CHILD_STDERR_KEEP_CHARS, tailOfOutput } from './modelManager'

describe('tailOfOutput', () => {
  // The bug this exists for: a Python traceback's cause is on its LAST line,
  // after an identical preamble of runpy/click frames. Keeping the head threw
  // the cause away and kept the boilerplate, so a real "OSError: [Errno 22]"
  // reached the user as a wall of frames ending mid-expression.
  it('keeps the end of a long traceback, where the exception actually is', () => {
    const traceback =
      'Traceback (most recent call last):\n' +
      'x'.repeat(CHILD_STDERR_KEEP_CHARS * 2) +
      '\nOSError: [Errno 22] Invalid argument'
    const out = tailOfOutput(traceback)
    expect(out).toContain('OSError: [Errno 22] Invalid argument')
    expect(out).not.toContain('Traceback (most recent call last)')
  })

  it('marks that it dropped something, so a truncated message is not read as the whole output', () => {
    expect(tailOfOutput('y'.repeat(CHILD_STDERR_KEEP_CHARS + 50))).toMatch(/^\.\.\./)
  })

  it('leaves short output alone, with no ellipsis', () => {
    expect(tailOfOutput('  boom  ')).toBe('boom')
  })
})
