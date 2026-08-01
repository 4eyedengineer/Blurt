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

/** A response for the non-streaming (warmup-style) JSON fallback path. */
function makeJsonResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** Extracts the ms-duration of the `input_audio` WAV part of a captured fetch call's request body. */
function audioMsFromFetchCall(call: unknown[], sampleRate: number): number {
  const init = call[1] as RequestInit
  const body = JSON.parse(init.body as string) as {
    messages: Array<{ content: Array<{ type: string; input_audio?: { data: string } }> }>
  }
  const parts = body.messages[0].content
  const audioPart = parts.find((p) => p.type === 'input_audio')
  if (!audioPart?.input_audio) throw new Error('no input_audio part in request body')
  const wavBytes = Buffer.from(audioPart.input_audio.data, 'base64').length
  const pcmBytes = wavBytes - 44
  return (pcmBytes / 2 / sampleRate) * 1000
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

describe('LitertBackend - rolling-window partial ticks', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Regression test for the "unbounded per-tick cost" finding: before the
   * rolling-window fix, every partial tick re-transcribed the ENTIRE session
   * buffer, so the audio
   * sent to the model grew linearly with session length. Feeds a session
   * far longer than one window's worth of audio and asserts every request's
   * WAV payload stays bounded by `partialWindowMs`, never approaching the
   * full session length.
   */
  it("keeps every partial tick's request audio bounded by partialWindowMs, regardless of total session length", async () => {
    fetchMock.mockImplementation(async () => makeJsonResponse('word'))

    const sampleRate = 16000
    const partialWindowMs = 1000
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 300,
      partialWindowMs,
      partialWindowOverlapMs: 200,
      minPartialIdleGapMs: 0,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const sessionId = await backend.startSession({ sampleRate })
    const chunkMs = 300
    const chunkSamples = Math.round((chunkMs / 1000) * sampleRate)

    // 10 pushes x 300ms = 3000ms of audio total - 3x the window size.
    for (let i = 0; i < 10; i++) {
      backend.pushAudio(sessionId, tone(chunkSamples))
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(9)

    const audioMsPerCall = fetchMock.mock.calls.map((call) =>
      audioMsFromFetchCall(call, sampleRate)
    )
    for (const ms of audioMsPerCall) {
      // A little rounding slack; must never approach the 3000ms total.
      expect(ms).toBeLessThanOrEqual(partialWindowMs + 5)
    }

    // The whole point: window size does not grow with session length - the
    // last tick's window is not meaningfully bigger than an earlier one
    // taken once the window has already kicked in.
    const laterCalls = audioMsPerCall.slice(3)
    for (const ms of laterCalls) {
      expect(ms).toBeLessThanOrEqual(partialWindowMs + 5)
    }
  })

  /**
   * End-to-end check that committed text from earlier windows survives
   * across ticks and gets correctly stitched with each new window's raw
   * transcript (see transcriptStitcher.ts) - i.e. the live displayed text is
   * always the full transcript-so-far, not just whatever the current
   * (bounded) window covers.
   */
  it("stitches committed text from earlier windows with each new window's transcript", async () => {
    const rawPerTick = [
      'hello', // tick1: window [0,40)
      'hello world how', // tick2: window [0,80) (no commit yet)
      'how are you', // tick3: window [60,120) - commits tick2's text first
      'how are you doing today', // tick4: window [60,160) (no new commit yet)
      'today please continue' // tick5: window [140,200) - commits tick4's text first
    ]
    let call = 0
    fetchMock.mockImplementation(async () => makeJsonResponse(rawPerTick[call++]))

    const sampleRate = 1000 // 1 sample == 1ms, for easy arithmetic
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 40,
      partialWindowMs: 100,
      partialWindowOverlapMs: 20,
      minPartialIdleGapMs: 0,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const partials: string[] = []
    const sessionId = await backend.startSession({ sampleRate })
    backend.onPartialTranscript((_sid, text) => partials.push(text))

    for (let i = 0; i < 5; i++) {
      backend.pushAudio(sessionId, tone(40))
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(fetchMock).toHaveBeenCalledTimes(5)
    // Each raw window transcript naturally re-says the tail of what's
    // already committed (since the windows overlap in audio) -
    // stitchTranscript should dedupe that overlap every time, so the final
    // displayed text reads as one continuous transcript with no repeats.
    expect(partials[partials.length - 1]).toBe(
      'hello world how are you doing today please continue'
    )
  })
})

describe('LitertBackend - spiral guard (minPartialIdleGapMs)', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Regression test for the "divergent spiral" finding: `msSinceLastPartial`
   * keeps accruing new audio ms while a tick is in flight (by design, see
   * partialTickScheduler.ts's doc comment), so the instant a tick completes
   * the backlog is often already far over the interval threshold - without
   * an idle-gap guard, the very next `pushAudio` call would launch another
   * tick immediately, with zero breathing room. Uses an injectable clock to
   * deterministically control "wall-clock time" independent of the fake
   * fetch's real async resolution.
   */
  it('does not launch the next tick until minPartialIdleGapMs has elapsed since the last completion', async () => {
    fetchMock.mockImplementation(async () => makeJsonResponse('word'))

    let currentNow = 1_000_000
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 50,
      minPartialIdleGapMs: 300,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000,
      now: () => currentNow
    })

    const sessionId = await backend.startSession({ sampleRate: 1000 })

    // First tick: nothing has ever completed, so it launches immediately.
    backend.pushAudio(sessionId, tone(60))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A large backlog of "new" audio arrives, but the clock hasn't moved -
    // the idle gap since the first tick's completion is 0ms (< 300ms), so
    // this must NOT launch a second tick yet.
    backend.pushAudio(sessionId, tone(600))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Advance the clock past the idle gap and push a little more audio -
    // NOW the backlog is allowed to launch.
    currentNow += 300
    backend.pushAudio(sessionId, tone(60))
    await new Promise((r) => setTimeout(r, 20))
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('LitertBackend - endSession on a longer (multi-window) session', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /**
   * Once a session has grown past one window's worth of audio (i.e.
   * `committedAudioMs > 0`), an in-flight partial tick's result only covers
   * the *current window*, not the whole buffer - reusing it the way short
   * sessions do (see the other describe block above) would silently skip
   * the "one accurate full-buffer final pass" `endSession` is supposed to
   * do for longer sessions. This asserts that extra full-buffer request
   * still happens, on top of (not instead of) the in-flight tick.
   */
  it('pays for one extra full-buffer final request rather than reusing an in-flight window tick', async () => {
    let call = 0
    fetchMock.mockImplementation(async () => {
      call++
      // The 4th call (the tick still in flight when endSession is invoked)
      // is deliberately slow, so it's still pending when we call endSession
      // right after triggering it.
      if (call === 4) return makeStreamingResponse(['slow'], 50)
      return makeJsonResponse(`word${call}`)
    })

    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 40,
      partialWindowMs: 100,
      partialWindowOverlapMs: 20,
      minPartialIdleGapMs: 0,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const sessionId = await backend.startSession({ sampleRate: 1000 })

    // 3 ticks complete normally (each awaited out before the next push).
    for (let i = 0; i < 3; i++) {
      backend.pushAudio(sessionId, tone(40))
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // By now the session has exceeded partialWindowMs (120ms > 100ms), so a
    // commit has happened and committedAudioMs > 0 - this is the "longer
    // session" case. Trigger tick #4 (slow) and immediately call endSession
    // with no further audio - the pre-fix code would have reused tick #4's
    // in-flight promise here; the fix must not.
    backend.pushAudio(sessionId, tone(40))
    const final = await backend.endSession(sessionId)

    expect(fetchMock).toHaveBeenCalledTimes(5) // 3 + the in-flight tick + one extra full pass
    expect(final).toBe('word5')
  })
})

/**
 * Regression tests for the invented-dictation bug.
 *
 * A real user's history.json contained two entries with an empty
 * `rawTranscript` (the transcription pass had correctly found no speech)
 * and `cleanedText: "I want to go to the store."` - a sentence nobody said,
 * manufactured by the cleanup pass when it was handed that empty string,
 * then copied to the clipboard and saved as a genuine dictation. The
 * rewrite prompts all say "clean up / rewrite the user's text", and a
 * generative model given an empty user message under that instruction
 * writes a plausible example rather than returning nothing.
 *
 * These assert on `fetch` not being called at all, not merely on the return
 * value: the fix is to never make the request. Asserting only on `''` would
 * still pass if the model were called and happened to return nothing that
 * run, which is exactly the non-determinism that made this bug intermittent
 * in the first place.
 */
describe('LitertBackend - blank input is never sent to a rewrite model', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function makeBackend(): LitertBackend {
    return new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      requestTimeoutMs: 5000
    })
  }

  // Whitespace-only counts as blank: an empty transcript that picked up a
  // stray newline somewhere in the wire/stitching layer is still nothing
  // said, and would hallucinate exactly the same way.
  const blanks: Array<[string, string]> = [
    ['empty string', ''],
    ['spaces', '   '],
    ['newline', '\n'],
    ['mixed whitespace', ' \t\r\n ']
  ]

  for (const [label, blank] of blanks) {
    it(`cleanup returns '' without any model call for ${label}`, async () => {
      const backend = makeBackend()
      await expect(backend.cleanup(blank)).resolves.toBe('')
      expect(fetchMock).not.toHaveBeenCalled()
    })
  }

  it("transform returns '' without any model call for blank input", async () => {
    const backend = makeBackend()
    await expect(backend.transform('   ', 'formal')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("voiceEdit returns '' without any model call for blank input", async () => {
    const backend = makeBackend()
    await expect(backend.voiceEdit('', 'replace foo with bar')).resolves.toBe('')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('still calls the model when there is real text to rewrite', async () => {
    fetchMock.mockResolvedValue(makeStreamingResponse(['Hello', ' there.'], 1))
    const backend = makeBackend()
    await expect(backend.cleanup('hello there')).resolves.toBe('Hello there.')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
