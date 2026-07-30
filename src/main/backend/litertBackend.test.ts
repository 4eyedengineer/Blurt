import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LitertBackend } from './litertBackend'

/** Encodes one OpenAI-style `chat.completion.chunk` SSE event carrying `delta`. */
function sseChunk(delta: string): string {
  return `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`
}

/**
 * A fake streaming `text/event-stream` Response that yields `tokens` one at
 * a time, `delayMs` apart, then `[DONE]` - close enough to the real
 * sidecar's SSE shape (see litertWire.ts) to exercise LitertBackend's
 * `readSSEStream` for real, without a live server.
 */
function makeStreamingResponse(tokens: string[], delayMs = 5): Response {
  const encoder = new TextEncoder()
  let i = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (i < tokens.length) {
        await new Promise((r) => setTimeout(r, delayMs))
        controller.enqueue(encoder.encode(sseChunk(tokens[i])))
        i++
      } else {
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      }
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' }
  })
}

/** Non-silent PCM16 samples (a constant tone) - clears the RMS silence guard. */
function tone(length: number): Int16Array {
  return new Int16Array(length).fill(5000)
}

describe('LitertBackend - endSession reusing an in-flight partial tick', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Regression test for the "frozen transcript" bug: a mid-recording partial
   * tick used to have its streamed output silently discarded (via a
   * `!session.ended` guard) the moment `endSession` was called while it was
   * still in flight, and `endSession` would then always kick off a second,
   * fully redundant re-transcription of the exact same audio from scratch -
   * so for a short recording (often exactly one tick in flight when the
   * user stops) the live transcript showed nothing at all until that second
   * request completed, doubling latency and making the streaming feature
   * look completely broken. Fixed by having `endSession` await and reuse
   * the in-flight tick's own promise when no new audio arrived after it
   * took its buffer snapshot, and by no longer suppressing its stream.
   */
  it('reuses the in-flight tick result (single fetch, no gap) when no new audio arrived after it started', async () => {
    fetchMock.mockResolvedValue(makeStreamingResponse(['The', ' history'], 5))

    const partials: string[] = []
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 50,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
    backend.onPartialTranscript((_sid, text) => partials.push(text))

    const sessionId = await backend.startSession({ sampleRate: 1000 })

    // One chunk representing 60ms of audio (> partialIntervalMs=50) fires a
    // tick synchronously (its fetch() call has been issued, but the fake
    // stream above hasn't resolved any tokens yet - see the delay).
    backend.pushAudio(sessionId, tone(60))

    // No further pushAudio calls - endSession is called with the exact same
    // buffer the in-flight tick already snapshotted.
    const final = await backend.endSession(sessionId)

    expect(final).toBe('The history')
    expect(partials).toContain('The history')
    // The whole point of the fix: exactly one HTTP request total, not two.
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('still emits partial events for the in-flight tick even though the session is already ended (no silent suppression)', async () => {
    fetchMock.mockResolvedValue(makeStreamingResponse(['Hello', ' world'], 5))

    const partials: string[] = []
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 50,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
    backend.onPartialTranscript((_sid, text) => partials.push(text))

    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.pushAudio(sessionId, tone(60))

    await backend.endSession(sessionId)

    // Before the fix, `partials` would only ever have received the final
    // flushed value from endSession's own *separate* re-transcription - the
    // in-flight tick's own progressive emissions ("Hello" alone, before
    // " world" arrived) were dropped entirely by the `!session.ended` guard.
    expect(partials.length).toBeGreaterThan(1)
    expect(partials[0]).toBe('Hello')
  })

  it('falls back to a fresh final re-transcription when more audio arrives after the in-flight tick snapshot', async () => {
    let call = 0
    fetchMock.mockImplementation(async () => {
      call++
      return call === 1
        ? makeStreamingResponse(['Hello'], 30)
        : makeStreamingResponse(['Hello', ' world'], 5)
    })

    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 50,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.pushAudio(sessionId, tone(60)) // fires tick #1 (slow, 30ms/token)
    backend.pushAudio(sessionId, tone(20)) // more audio arrives before endSession

    const final = await backend.endSession(sessionId)

    expect(final).toBe('Hello world')
    // Correctness requires a second request here (the first tick's snapshot
    // didn't include the second chunk) - two fetches is expected/correct in
    // this case, unlike the no-new-audio case above.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
