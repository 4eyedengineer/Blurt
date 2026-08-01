import { beforeEach, describe, expect, it, vi } from 'vitest'

// overlayController imports `clipboard` from electron at module scope, and
// calls into the real overlay window / paste-injection modules - none of
// which exist outside a running Electron app. Mocked here so the
// controller's own decision logic can be tested as the pure state machine
// it is.
vi.mock('electron', () => ({ clipboard: { writeText: vi.fn() } }))
vi.mock('./overlay', () => ({ showOverlayWindow: vi.fn() }))
vi.mock('./log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const copyAndPaste = vi.fn()
vi.mock('./paste', () => ({
  copyAndPaste: (...args: unknown[]) => copyAndPaste(...args)
}))

import { OverlayController } from './overlayController'
import { IPC } from '../shared/ipc-channels'

interface ResultPayload {
  rawTranscript: string
  cleanedText: string
  durationMs: number
  error?: string
}

/**
 * Builds a controller wired to fakes, and returns the handler registered for
 * IPC.overlay.result so a test can deliver a result payload exactly the way
 * the overlay renderer does.
 */
function makeController(): {
  deliverResult: (payload: ResultPayload) => Promise<void>
  historySaves: unknown[]
  historyChangedCount: () => number
} {
  const pushToTalk = { on: vi.fn() }
  const historySaves: unknown[] = []
  const historyStore = {
    save: (entry: unknown) => {
      historySaves.push(entry)
      return { id: 'entry-1' }
    }
  }
  let historyChanged = 0

  let resultHandler: ((event: unknown, payload: ResultPayload) => void) | null = null
  const ipcMain = {
    on: (channel: string, handler: (event: unknown, payload: ResultPayload) => void) => {
      if (channel === IPC.overlay.result) resultHandler = handler
    }
  }

  new OverlayController(
    pushToTalk as never,
    () => null,
    { get: () => ({ pushToTalk: { autoPaste: true } }) } as never,
    historyStore as never,
    () => {
      historyChanged++
    },
    ipcMain as never
  )

  return {
    deliverResult: async (payload) => {
      if (!resultHandler) throw new Error('IPC.overlay.result handler was never registered')
      resultHandler(null, payload)
      // handleResult is async and fired with `void` - let its microtasks run.
      await Promise.resolve()
      await Promise.resolve()
    },
    historySaves,
    historyChangedCount: () => historyChanged
  }
}

/**
 * Regression tests for the "invented dictation" bug's most destructive
 * consequence.
 *
 * When a push-to-talk hold captured no speech, the transcript came back
 * empty, the cleanup model invented a sentence to fill the void ("I want to
 * go to the store." - observed verbatim in a real user's history), and this
 * controller then copied that sentence to the clipboard and, with auto-paste
 * on, typed it into whatever window the user happened to be focused on.
 *
 * The upstream fix (never calling a rewrite model with blank input) means
 * the payload now arrives here empty instead of invented. This is the
 * backstop for that: an empty result must be inert. Note that on this path
 * "do nothing" is not merely a missed feature - `copyAndPaste` would
 * *overwrite* whatever the user already had on their clipboard with an
 * empty string, so a silent no-speech hold would silently cost them
 * unrelated data.
 */
describe('OverlayController - a hold that captured no speech is inert', () => {
  beforeEach(() => {
    copyAndPaste.mockReset()
    copyAndPaste.mockResolvedValue({ copied: true, pasted: true, message: null })
  })

  const empties = ['', '   ', '\n', ' \t\r\n ']

  for (const cleanedText of empties) {
    it(`does not touch the clipboard or history for ${JSON.stringify(cleanedText)}`, async () => {
      const { deliverResult, historySaves, historyChangedCount } = makeController()
      await deliverResult({ rawTranscript: '', cleanedText, durationMs: 1200 })

      expect(copyAndPaste).not.toHaveBeenCalled()
      expect(historySaves).toEqual([])
      expect(historyChangedCount()).toBe(0)
    })
  }

  it('still copies, pastes and records a real dictation', async () => {
    const { deliverResult, historySaves, historyChangedCount } = makeController()
    await deliverResult({
      rawTranscript: 'hello there',
      cleanedText: 'Hello there.',
      durationMs: 1200
    })

    expect(copyAndPaste).toHaveBeenCalledTimes(1)
    expect(copyAndPaste.mock.calls[0][1]).toBe('Hello there.')
    expect(historySaves).toHaveLength(1)
    expect(historyChangedCount()).toBe(1)
  })

  it('does not touch the clipboard or history when the dictation failed outright', async () => {
    const { deliverResult, historySaves } = makeController()
    await deliverResult({
      rawTranscript: '',
      cleanedText: '',
      durationMs: 0,
      error: 'Microphone capture failed: NotAllowedError'
    })

    expect(copyAndPaste).not.toHaveBeenCalled()
    expect(historySaves).toEqual([])
  })
})
