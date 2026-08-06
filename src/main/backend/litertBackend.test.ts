import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEFAULT_PARTIAL_INTERVAL_MS,
  DEFAULT_PARTIAL_WINDOW_MS,
  DEFAULT_PARTIAL_WINDOW_OVERLAP_MS,
  LitertBackend
} from './litertBackend'

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

/**
 * A response from the speech-recognition route (see resources/asr.py and
 * LitertBackend.transcribeAudio). Transcription no longer goes through
 * chat-completions at all - the recogniser answers with one plain JSON
 * object rather than an SSE token stream.
 */
function makeTranscriptResponse(text: string): Response {
  return new Response(JSON.stringify({ text }), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/**
 * A transcription response that takes `delayMs` to arrive, for the tests
 * that need a tick still in flight when endSession is called. The delay is
 * in the body stream rather than around the fetch itself, so the request is
 * genuinely issued and pending - which is the condition under test.
 */
function makeSlowTranscriptResponse(text: string, delayMs: number): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      await new Promise((r) => setTimeout(r, delayMs))
      controller.enqueue(encoder.encode(JSON.stringify({ text })))
      controller.close()
    }
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

/** Extracts the ms-duration of the WAV a captured transcription call sent. */
function audioMsFromFetchCall(call: unknown[], sampleRate: number): number {
  const init = call[1] as RequestInit
  const body = JSON.parse(init.body as string) as { wav?: string }
  if (!body.wav) throw new Error('no wav in transcription request body')
  const wavBytes = Buffer.from(body.wav, 'base64').length
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
   * endSession once reused an in-flight tick's result for short recordings,
   * to avoid a second identical request. That was removed when ticks and the
   * final pass briefly ran on different models, and is deliberately left
   * removed now they share one again: the recogniser answers in ~330ms, so
   * the redundant call this saved is no longer worth the coupling between
   * endSession and whatever a tick happens to have in flight.
   */
  it('runs its own final pass rather than reusing an in-flight tick', async () => {
    fetchMock.mockResolvedValue(makeTranscriptResponse('The history'))

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

    // The tick, then a distinct final request - not one reused for both.
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
    for (const call of fetchMock.mock.calls) {
      expect(String(call[0])).toBe('http://test-sidecar/blurt/transcribe')
    }
  })

  it('still emits the in-flight tick even though the session is already ended (no silent suppression)', async () => {
    fetchMock.mockResolvedValue(makeTranscriptResponse('Hello world'))

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

    // The guarded behaviour: a tick that was still in flight when the
    // session ended must still deliver its result, rather than being
    // dropped by the `!session.ended` check that used to sit here.
    //
    // This used to assert progressive emissions ("Hello" arriving before
    // " world"), which was a property of streaming an SSE token feed from
    // the chat model. The recogniser answers with a whole window at a time
    // (see LitertBackend.transcribeAudio), so one tick is one emission by
    // construction and the old assertion could only ever fail. What it was
    // really protecting - that the emission happens at all after `ended` -
    // is unchanged and is what is asserted now.
    expect(partials).toContain('Hello world')
  })

  it('falls back to a fresh final re-transcription when more audio arrives after the in-flight tick snapshot', async () => {
    let call = 0
    fetchMock.mockImplementation(async () => {
      call++
      return call === 1
        ? makeSlowTranscriptResponse('Hello', 30)
        : makeTranscriptResponse('Hello world')
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
    fetchMock.mockImplementation(async () => makeTranscriptResponse('word'))

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
    // One word per 20ms of audio: hello[0,20) world[20,40) how[40,60)
    // are[60,80) you[80,100) doing[100,120) today[120,140) please[140,160)
    // continue[160,180) now[180,200). Each entry below is what a recogniser
    // handed that tick's window would say.
    const rawPerTick = [
      'hello world', // tick1: window [0,40)
      'world how are', // tick2: window [20,80)
      'world how are you doing', // tick3: window [20,120)
      'doing today please', // tick4: window [100,160)
      'doing today please continue now' // tick5: window [100,200)
    ]
    let call = 0
    fetchMock.mockImplementation(async () => makeTranscriptResponse(rawPerTick[call++]))

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
      'hello world how are you doing today please continue now'
    )
  })

  /**
   * A window that decodes to nothing used to cost the live transcript
   * everything since the last commit, permanently.
   *
   * `stitchTranscript(committed, '')` returns `committed`, so an empty window
   * transcript was stored as the commit candidate (dropping every word the
   * uncommitted region had already shown) while `lastTickAudioMs` still
   * advanced to that tick's audio position. The next commit promoted the two
   * together: a boundary saying "final up to here" attached to text that
   * stopped up to a whole window earlier. Committed text is never re-decoded,
   * so those words were gone.
   *
   * The recogniser returns '' for any window it cannot make out - a pause, a
   * breath, a cough - none of which the RMS silence guard catches, so this is
   * an ordinary event rather than an edge case.
   */
  it('does not lose committed words when one window decodes to nothing', async () => {
    // Same 20ms-per-word audio as the test above. Tick 3's window decodes to
    // nothing; ticks 4 and 5 then have to carry on as if it had never fired.
    const rawPerTick = [
      'hello world', // tick1: window [0,40)
      'world how are', // tick2: window [20,80)
      '', // tick3: window [20,120) - undecodable
      'are you doing today please', // tick4: window [60,160)
      'doing today please continue now' // tick5: window [100,200)
    ]
    let call = 0
    fetchMock.mockImplementation(async () => makeTranscriptResponse(rawPerTick[call++]))

    const sampleRate = 1000
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
    // Previously: 'hello world doing today please continue now' - "how are
    // you" deleted by the empty tick, three words the speaker actually said.
    expect(partials[partials.length - 1]).toBe(
      'hello world how are you doing today please continue now'
    )
    // The empty tick must not reach the renderer either: shown on its own it
    // would rewind the teleprompter to the last commit boundary and then jump
    // forward again on the next tick. Five ticks, four updates.
    expect(partials).toHaveLength(4)
    expect(partials.every((p, i) => i === 0 || p.length >= partials[i - 1].length)).toBe(true)
  })

  /**
   * `partialWindowOverlapMs` exists so a word cut off at the commit boundary
   * is heard whole by the next window, and `stitchTranscript` has repeated
   * words to align the seam on. Both depend on the window genuinely reaching
   * back past the boundary.
   *
   * It did not, once per commit cycle. The window is anchored to "now" while
   * the overlap is measured back from the commit boundary, so as audio
   * accrued between commits the `partialWindowMs` cap ate into the overlap
   * from the front - by the tick before each commit it had shrunk from 800ms
   * to 200ms at the shipped constants. Committing a window's-worth of audio
   * earlier keeps the window pinned to `boundary - overlap` instead.
   *
   * Asserted through the one externally visible consequence: a tick whose
   * window has been clipped to exactly `partialWindowMs` is a tick that lost
   * overlap, because the cap is the only thing that clips it.
   */
  it('never lets the window cap eat into the overlap', async () => {
    fetchMock.mockImplementation(async () => makeTranscriptResponse('word'))

    const sampleRate = 1000
    // Scaled 1:10 from the shipped 700/3000/800 so the ratios that produce
    // the squeeze are preserved.
    const partialWindowMs = 300
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 70,
      partialWindowMs,
      partialWindowOverlapMs: 80,
      minPartialIdleGapMs: 0,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const sessionId = await backend.startSession({ sampleRate })
    for (let i = 0; i < 10; i++) {
      backend.pushAudio(sessionId, tone(70))
      await new Promise((r) => setTimeout(r, 20))
    }

    expect(fetchMock).toHaveBeenCalledTimes(10)
    const windowMs = fetchMock.mock.calls.map((call) => audioMsFromFetchCall(call, sampleRate))
    // Previously [70, 140, 210, 280, 150, 220, 290, 300, 150, 220] - the 300
    // is the clipped tick, and it is the one whose overlap had collapsed.
    expect(windowMs).toEqual([70, 140, 150, 220, 290, 150, 220, 290, 150, 220])
    for (const ms of windowMs) {
      expect(ms).toBeLessThan(partialWindowMs)
    }
  })
})

describe('LitertBackend - custom vocabulary', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function backendWithVocabulary(vocabulary: string[]): LitertBackend {
    return new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      getVocabulary: () => vocabulary,
      partialIntervalMs: 40,
      partialWindowMs: 100,
      partialWindowOverlapMs: 20,
      minPartialIdleGapMs: 0,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
  }

  /**
   * Corrections are applied where audio becomes text, so the live transcript
   * carries them too. Fixing them only in the cleanup pass would leave the
   * term visibly wrong on screen for the whole utterance.
   */
  it('corrects the live transcript, not just the final text', async () => {
    fetchMock.mockImplementation(async () => makeTranscriptResponse('we tried Quin 30B today'))
    const backend = backendWithVocabulary(['Quin -> Qwen'])

    const partials: string[] = []
    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.onPartialTranscript((_sid, text) => partials.push(text))

    backend.pushAudio(sessionId, tone(40))
    await new Promise((r) => setTimeout(r, 30))

    expect(partials[partials.length - 1]).toBe('we tried Qwen 30B today')
    await expect(backend.endSession(sessionId)).resolves.toBe('we tried Qwen 30B today')
  })

  /**
   * A correction has already been applied to the transcript by the time
   * cleanup runs, so repeating it in the prompt would spend budget asking the
   * model to fix something that is no longer there. Only plain spellings are
   * worth the tokens.
   */
  it('sends spellings to the cleanup prompt and keeps corrections out of it', async () => {
    fetchMock.mockImplementation(async () => makeStreamingResponse(['ok']))
    const backend = backendWithVocabulary(['Kubernetes', 'Quin -> Qwen'])

    await backend.cleanup('some text')

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string) as {
      messages: Array<{ content: string }>
    }
    // Asserted on the hint line rather than the whole prompt: the prompt's
    // own number examples contain "->", so its absence proves nothing.
    const system = body.messages[0].content
    expect(system).toContain('Spell these terms this way wherever they appear: Kubernetes.')
    expect(system).not.toContain('Qwen')
    expect(system).not.toContain('Quin')
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
    fetchMock.mockImplementation(async () => makeTranscriptResponse('word'))

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
      if (call === 4) return makeSlowTranscriptResponse('slow', 50)
      return makeTranscriptResponse(`word${call}`)
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

/**
 * Transcription moved off the language model and onto a dedicated
 * recogniser (see resources/asr.py). What these pin down is the split
 * itself: audio must reach the recogniser's route and nothing else, and the
 * language model must keep every job that is not turning audio into words.
 */
describe('LitertBackend - transcription goes to the recogniser, not the LLM', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  function urlOf(call: unknown[]): string {
    return String(call[0])
  }

  it('sends audio to /blurt/transcribe and never to chat completions', async () => {
    fetchMock.mockResolvedValue(makeTranscriptResponse('hello world'))
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 100_000, // no partial ticks; just the final pass
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })

    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.pushAudio(sessionId, tone(500))
    await expect(backend.endSession(sessionId)).resolves.toBe('hello world')

    const urls = fetchMock.mock.calls.map(urlOf)
    expect(urls).toContain('http://test-sidecar/blurt/transcribe')
    expect(urls.some((u) => u.includes('/v1/chat/completions'))).toBe(false)
  })

  it('still sends cleanup to the language model', async () => {
    fetchMock.mockResolvedValue(makeStreamingResponse(['Hello', ' world.'], 1))
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
    await expect(backend.cleanup('hello world')).resolves.toBe('Hello world.')
    expect(urlOf(fetchMock.mock.calls[0])).toBe('http://test-sidecar/v1/chat/completions')
  })

  /**
   * The recogniser answers 503 when its model files are missing (see
   * serve_gpu.py's transcribe route). That has to surface as a real
   * rejection: silently handing the audio back to the language model is
   * exactly the fallback this change exists to remove, and would quietly
   * restore the worse transcription nobody asked for.
   */
  /**
   * The recogniser answers 503 when its model files are missing (see
   * serve_gpu.py's transcribe route). Two things have to hold. The failure
   * has to reach the user - it does so on the out-of-band session-error
   * channel, which is how every mid-session failure has always been
   * reported (endSession itself resolves with whatever text it has rather
   * than rejecting; see its catch blocks). And the audio must not then be
   * handed to the language model instead: a silent fallback would restore
   * exactly the worse transcription this change exists to remove, and hide
   * that it had happened.
   */
  it('reports a missing recogniser and never falls back to the language model', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'The speech recognition model is not installed.' }), {
        status: 503,
        headers: { 'content-type': 'application/json' }
      })
    )
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 100_000,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
    const errors: string[] = []
    backend.onError((_sid, err) => errors.push(err.message))

    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.pushAudio(sessionId, tone(500))
    await backend.endSession(sessionId)

    expect(errors.join(' ')).toMatch(/not installed/)
    expect(fetchMock.mock.calls.every((c) => !urlOf(c).includes('/v1/chat/completions'))).toBe(true)
  })

  it('reports a response with no transcript in it rather than treating it as silence', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ unexpected: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    )
    const backend = new LitertBackend({
      getBaseUrl: () => 'http://test-sidecar',
      modelId: 'e2b',
      partialIntervalMs: 100_000,
      streamThrottleMs: 1,
      requestTimeoutMs: 5000
    })
    const errors: string[] = []
    backend.onError((_sid, err) => errors.push(err.message))

    const sessionId = await backend.startSession({ sampleRate: 1000 })
    backend.pushAudio(sessionId, tone(500))
    await backend.endSession(sessionId)

    expect(errors.join(' ')).toMatch(/no transcript/i)
  })
})

/**
 * The live transcript's cadence is a budget, not a preference: what the user
 * sees is `max(interval, tickCost + minIdleGap)`. These constants were
 * retuned once already, after transcription moved off the language model
 * made a tick roughly three times cheaper, and the numbers only make sense
 * together. Pinned here so a later change to one of them has to be
 * deliberate.
 */
describe('live transcript cadence constants', () => {
  it('keeps the commit boundary advancing (window must exceed its overlap)', () => {
    // windowStart reaches back `overlap` ms into already-committed audio, so
    // an overlap at or past the window size would leave each tick covering
    // no new ground and nothing would ever commit.
    expect(DEFAULT_PARTIAL_WINDOW_OVERLAP_MS).toBeLessThan(DEFAULT_PARTIAL_WINDOW_MS)
  })

  it('keeps consecutive ticks overlapping, so the shown text stays stable', () => {
    // A tick fires every `interval` ms of new audio and re-reads the trailing
    // `window` ms. With interval >= window, consecutive ticks would share no
    // audio at all and the transcript would visibly jump rather than settle.
    expect(DEFAULT_PARTIAL_INTERVAL_MS).toBeLessThan(DEFAULT_PARTIAL_WINDOW_MS)
  })

  /**
   * Measured on a real Windows machine, warm: a 3s window costs ~557ms.
   * The interval has to stay above that or the cadence stops being
   * interval-bound and becomes whatever the hardware manages, which is the
   * unpredictable behaviour the budget exists to avoid.
   */
  it('leaves the interval above the measured cost of one window', () => {
    const measuredThreeSecondWindowMs = 557
    expect(DEFAULT_PARTIAL_INTERVAL_MS).toBeGreaterThan(measuredThreeSecondWindowMs)
  })
})
