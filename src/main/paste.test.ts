import { describe, expect, it, vi } from 'vitest'
import {
  buildLinuxXdotoolArgs,
  buildMacosOsascriptArgs,
  buildWindowsSendKeysArgs,
  buildWindowsSendKeysCommand,
  copyAndPaste,
  describePasteFailure,
  getInjectPasteExecOptions,
  type ClipboardLike
} from './paste'

function fakeClipboard(): ClipboardLike & { written: string[] } {
  const written: string[] = []
  return {
    written,
    writeText: (text: string) => {
      written.push(text)
    }
  }
}

/**
 * `process.platform` is defined as a non-writable-but-configurable property,
 * so a plain `process.platform = ...` assignment throws in strict mode -
 * this redefines it for the duration of `fn` and restores the original
 * value afterward (even if `fn` rejects). `fn` is awaited *inside* the
 * try/finally, not just invoked, because copyAndPaste's platform reads
 * happen after its first `await` (the PASTE_SETTLE_MS delay) - restoring
 * synchronously right after calling fn() would put the real platform back
 * before those reads ever ran.
 *
 * Only the one copyAndPaste test below needs this: it exercises the darwin
 * branch through copyAndPaste's own internal `process.platform` reads
 * (describeInjectCommand, describePasteFailure's call site). The pure
 * functions (buildMacosOsascriptArgs, describePasteFailure) take platform
 * as an explicit parameter instead and never need this helper - see the
 * describePasteFailure doc comment in paste.ts for why.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

describe('paste command builders', () => {
  it('builds xdotool args with --clearmodifiers so a still-held key is not folded into the combo', () => {
    expect(buildLinuxXdotoolArgs()).toEqual(['key', '--clearmodifiers', 'ctrl+v'])
  })

  it('builds Windows powershell argv with -WindowStyle Hidden and -NonInteractive so no console is left visible', () => {
    const args = buildWindowsSendKeysArgs()
    expect(args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-Command',
      buildWindowsSendKeysCommand()
    ])
  })

  it(
    'sets windowsHide:true on the exec options for the Windows paste injection - without this, spawning ' +
      'powershell creates a visible conhost window that steals OS focus at the exact moment Ctrl+V needs to ' +
      'land, dropping the auto-paste (see paste.ts doc comments)',
    () => {
      expect(getInjectPasteExecOptions()).toEqual({ windowsHide: true })
    }
  )

  it('builds osascript args that tell System Events to keystroke "v" with Cmd (not Ctrl) held', () => {
    expect(buildMacosOsascriptArgs()).toEqual([
      '-e',
      'tell application "System Events" to keystroke "v" using command down'
    ])
  })
})

describe('describePasteFailure', () => {
  it('returns the generic clipboard-preserved message on win32 regardless of reason', () => {
    expect(describePasteFailure('win32', 'some SendKeys failure')).toBe(
      'Paste failed. The text is on your clipboard.'
    )
  })

  it('returns the generic message on linux regardless of reason', () => {
    expect(describePasteFailure('linux', 'xdotool not found on PATH')).toBe(
      'Paste failed. The text is on your clipboard.'
    )
  })

  it('returns the generic message on darwin for a reason unrelated to Accessibility', () => {
    expect(describePasteFailure('darwin', 'osascript: command not found')).toBe(
      'Paste failed. The text is on your clipboard.'
    )
  })

  it('returns the actionable Accessibility message on darwin when the reason names "assistive access"', () => {
    expect(
      describePasteFailure(
        'darwin',
        'execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'
      )
    ).toBe(
      'Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & ' +
        'Security > Accessibility - the text is on your clipboard.'
    )
  })

  it('matches "assistive access" case-insensitively', () => {
    expect(describePasteFailure('darwin', 'Not Allowed ASSISTIVE ACCESS')).toBe(
      'Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & ' +
        'Security > Accessibility - the text is on your clipboard.'
    )
  })

  it('also recognizes the bare -1719 error code without the "assistive access" wording', () => {
    expect(describePasteFailure('darwin', 'osascript error -1719')).toBe(
      'Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & ' +
        'Security > Accessibility - the text is on your clipboard.'
    )
  })

  it('does NOT apply the darwin Accessibility message on other platforms even with matching wording', () => {
    // Same reason text that triggers the darwin branch, but on linux/win32
    // it should fall through to the generic message unchanged - the
    // "assistive access"/-1719 pattern only means something on darwin.
    expect(describePasteFailure('linux', 'not allowed assistive access (-1719)')).toBe(
      'Paste failed. The text is on your clipboard.'
    )
  })
})

describe('copyAndPaste', () => {
  it('leaves the clipboard untouched when there is nothing to copy', async () => {
    const clipboard = fakeClipboard()
    const outcome = await copyAndPaste(clipboard, '', true)
    expect(clipboard.written).toEqual([])
    expect(outcome).toEqual({ copied: false, pasted: false, message: 'Nothing to copy.' })
  })

  it('copies but does not attempt injection when autoPaste is disabled', async () => {
    const clipboard = fakeClipboard()
    const injectPaste = vi.fn().mockResolvedValue(undefined)
    const outcome = await copyAndPaste(clipboard, 'hello', false, injectPaste)
    expect(clipboard.written).toEqual(['hello'])
    expect(injectPaste).not.toHaveBeenCalled()
    expect(outcome).toEqual({
      copied: true,
      pasted: false,
      message: 'Copied. Press Ctrl+V to paste.'
    })
  })

  it('reports pasted:true when injection succeeds', async () => {
    const clipboard = fakeClipboard()
    const injectPaste = vi.fn().mockResolvedValue(undefined)
    const outcome = await copyAndPaste(clipboard, 'hello', true, injectPaste)
    expect(injectPaste).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({ copied: true, pasted: true, message: 'Copied and pasted.' })
  })

  it('reports a visible paste failure (not a silent clipboard-only downgrade) if injection throws', async () => {
    const clipboard = fakeClipboard()
    const injectPaste = vi.fn().mockRejectedValue(new Error('xdotool not found on PATH'))
    const outcome = await copyAndPaste(clipboard, 'hello', true, injectPaste)
    expect(outcome).toEqual({
      copied: true,
      pasted: false,
      message: 'Paste failed. The text is on your clipboard.'
    })
  })

  it('turns a rejecting darwin injection missing Accessibility permission into the actionable message, while still reporting copied:true, pasted:false (never a silent clipboard-only downgrade)', async () => {
    const clipboard = fakeClipboard()
    const injectPaste = vi
      .fn()
      .mockRejectedValue(
        new Error(
          'Command failed: osascript -e ...\n' +
            '28:41: execution error: System Events got an error: osascript is not allowed assistive access. (-1719)'
        )
      )
    const outcome = await withPlatform('darwin', () =>
      copyAndPaste(clipboard, 'hello', true, injectPaste)
    )
    expect(clipboard.written).toEqual(['hello'])
    expect(injectPaste).toHaveBeenCalledTimes(1)
    expect(outcome).toEqual({
      copied: true,
      pasted: false,
      message:
        'Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & ' +
        'Security > Accessibility - the text is on your clipboard.'
    })
  })
})
