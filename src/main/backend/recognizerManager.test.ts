import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../log', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

import { RecognizerManager } from './recognizerManager'

/**
 * A response body delivered in one chunk, with the content-length the caller
 * expects - pass a larger `contentLength` than the body to simulate a
 * download that ends early.
 */
function bodyResponse(text: string, contentLength = Buffer.byteLength(text)): Response {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-length': String(contentLength) }
  })
}

describe('RecognizerManager', () => {
  let dir: string
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'recognizer-test-'))
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.unstubAllGlobals()
  })

  it('downloads both files and reports ready', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      bodyResponse(
        url.includes('tokenizer') ? '{"vocab":1}' : url.includes('small.en') ? 'FINAL' : 'LIVE'
      )
    )
    const manager = new RecognizerManager(dir)
    expect(manager.isInstalled()).toBe(false)

    const paths = await manager.ensureDownloaded()

    expect(readFileSync(paths.modelPath, 'utf-8')).toBe('LIVE')
    expect(readFileSync(paths.finalModelPath, 'utf-8')).toBe('FINAL')
    expect(readFileSync(paths.tokenizerPath, 'utf-8')).toBe('{"vocab":1}')
    expect(manager.isInstalled()).toBe(true)
    expect(manager.getStatus().state).toBe('ready')
  })

  it('does not download again when every file is already there', async () => {
    const manager = new RecognizerManager(dir)
    const paths = manager.getPaths()
    writeFileSync(paths.modelPath, 'LIVE')
    writeFileSync(paths.finalModelPath, 'FINAL')
    writeFileSync(paths.tokenizerPath, '{}')

    await manager.ensureDownloaded()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  /**
   * The failure this guards against is the quiet one: a download cut off
   * partway leaves a file that exists, so `isInstalled()` says yes, and the
   * recogniser then fails to load a truncated graph on every dictation with
   * nothing pointing at the download as the cause.
   */
  it('leaves nothing installed when the body ends early', async () => {
    fetchMock.mockImplementation(async () => bodyResponse('SHORT', 99999))
    const manager = new RecognizerManager(dir)

    await expect(manager.ensureDownloaded()).rejects.toThrow(/ended early/)
    expect(manager.isInstalled()).toBe(false)
    expect(existsSync(manager.getPaths().modelPath)).toBe(false)
    // Not even as a leftover .part. Checked in the recogniser's own
    // directory, not the userData root it lives under.
    expect(readdirSync(dirname(manager.getPaths().modelPath))).toEqual([])
    expect(manager.getStatus().state).toBe('error')
  })

  /**
   * The weights are fetched first precisely so this cannot leave a lone
   * tokenizer behind - `isInstalled()` is all-or-nothing, and a half-install
   * that reported ready would be indistinguishable from a real one.
   */
  it('leaves nothing installed when the second file fails', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('tokenizer') ? new Response('nope', { status: 404 }) : bodyResponse('WEIGHTS')
    )
    const manager = new RecognizerManager(dir)

    await expect(manager.ensureDownloaded()).rejects.toThrow(/404/)
    expect(manager.isInstalled()).toBe(false)
  })

  it('reports a short, user-facing reason rather than the HTTP detail', async () => {
    fetchMock.mockImplementation(async () => new Response('nope', { status: 500 }))
    const manager = new RecognizerManager(dir)

    await expect(manager.ensureDownloaded()).rejects.toThrow(/500/)
    expect(manager.getStatus().error).toBe('Could not download the speech recognition model.')
  })

  /** Two callers (a rebuild and a retry) must share one download, not race on the same .part file. */
  it('shares a single in-flight download between concurrent callers', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      bodyResponse(url.includes('tokenizer') ? '{}' : url.includes('small.en') ? 'FINAL' : 'LIVE')
    )
    const manager = new RecognizerManager(dir)

    const [a, b] = await Promise.all([manager.ensureDownloaded(), manager.ensureDownloaded()])

    expect(a).toEqual(b)
    // Three files, fetched once each - not six.
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('reports download progress for the weights', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      bodyResponse(url.includes('tokenizer') ? '{}' : url.includes('small.en') ? 'FINAL' : 'LIVE')
    )
    const manager = new RecognizerManager(dir)
    const states: string[] = []
    manager.on('status', (s) => states.push(s.state))

    await manager.ensureDownloaded()

    expect(states).toContain('downloading')
    expect(states[states.length - 1]).toBe('ready')
  })
})
