import { describe, expect, it, vi } from 'vitest'
import {
  buildLinuxXdotoolArgs,
  buildWindowsSendKeysArgs,
  buildWindowsSendKeysCommand,
  copyAndPaste,
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
})
