import { describe, expect, it } from 'vitest'
import {
  buildCleanupRequest,
  buildTransformRequest,
  buildVoiceEditRequest,
  buildWarmupRequest,
  computeRms,
  concatInt16,
  extractContentFromChatCompletionResponse,
  extractDeltaFromChatCompletionChunk,
  isStreamDone,
  parseSSEBuffer,
  pcm16ToWavBase64,
  pcm16ToWavBuffer,
  safeJsonParse,
  sliceTrailingWindow,
  stripModelPreamble
} from './litertWire'

describe('request builders', () => {
  it('omits the vocabulary hint when there is no custom vocabulary', () => {
    const req = buildCleanupRequest({ model: 'gemma-4-e2b', text: 'hello' })
    const system = req.messages[0]
    expect(system.role).toBe('system')
    expect(system.content).not.toContain('commonly uses')
  })

  it('builds a distinct prompt per transform mode', () => {
    const modes = ['keypoints', 'formal', 'short', 'long'] as const
    const prompts = modes.map(
      (mode) => buildTransformRequest({ model: 'm', text: 't', mode }).messages[0].content
    )
    expect(new Set(prompts).size).toBe(modes.length)
  })

  it('builds a voice-edit request embedding both the text and the command', () => {
    const req = buildVoiceEditRequest({
      model: 'm',
      text: 'hello world',
      command: 'uppercase everything'
    })
    expect(req.messages[1].content).toContain('hello world')
    expect(req.messages[1].content).toContain('uppercase everything')
  })

  it('builds a text-only warmup request, carrying no audio', () => {
    // The inverse of what this test used to assert. Warmup deliberately
    // carried a silent input_audio part while Gemma did the transcribing, to
    // force its lazily-loaded audio submodel to load ahead of the user's
    // first utterance. Transcription now runs on a separate recogniser (see
    // resources/asr.py) and nothing sends audio to the LLM at all, so that
    // part was pulling a multi-GB submodel into memory on every startup to
    // warm a path with no callers. Asserted rather than just deleted so a
    // future "warmup should probably include audio" instinct trips a test
    // that explains why it should not.
    const req = buildWarmupRequest('gemma-4-e2b')
    expect(req.stream).toBe(false)
    expect(req.messages).toHaveLength(1)
    expect(req.messages[0].content).toBe('Hi')
    expect(JSON.stringify(req)).not.toContain('input_audio')
  })
})

describe('SSE parsing', () => {
  it('parses complete events and keeps an incomplete trailing event as remainder', () => {
    const buffer = 'data: {"a":1}\n\ndata: {"a":2}\n\ndata: {"a":3' // last event incomplete
    const { events, remainder } = parseSSEBuffer(buffer)
    expect(events).toHaveLength(2)
    expect(events[0].data).toBe('{"a":1}')
    expect(events[1].data).toBe('{"a":2}')
    expect(remainder).toBe('data: {"a":3')
  })

  it('feeds the remainder back in and eventually parses the final event', () => {
    const first = parseSSEBuffer('data: {"a":3')
    const second = parseSSEBuffer(`${first.remainder}}\n\n`)
    expect(second.events).toHaveLength(1)
    expect(second.events[0].data).toBe('{"a":3}')
  })

  it('captures an explicit event: field alongside data', () => {
    const { events } = parseSSEBuffer('event: message\ndata: hello\n\n')
    expect(events[0]).toEqual({ event: 'message', data: 'hello' })
  })

  it('recognizes the [DONE] sentinel', () => {
    expect(isStreamDone('[DONE]')).toBe(true)
    expect(isStreamDone(' [DONE] ')).toBe(true)
    expect(isStreamDone('{"a":1}')).toBe(false)
  })

  it('extracts a delta from a chat.completion.chunk-shaped payload', () => {
    const chunk = { choices: [{ delta: { content: 'Hel' } }] }
    expect(extractDeltaFromChatCompletionChunk(chunk)).toBe('Hel')
  })

  it('falls back to message.content when delta is absent (final-chunk variant)', () => {
    const chunk = { choices: [{ message: { content: 'full text' } }] }
    expect(extractDeltaFromChatCompletionChunk(chunk)).toBe('full text')
  })

  it('returns null for malformed/unexpected shapes rather than throwing', () => {
    expect(extractDeltaFromChatCompletionChunk(null)).toBeNull()
    expect(extractDeltaFromChatCompletionChunk({})).toBeNull()
    expect(extractDeltaFromChatCompletionChunk({ choices: [] })).toBeNull()
  })

  it('extracts content from a non-streamed chat completion response', () => {
    const res = { choices: [{ message: { content: 'hello' } }] }
    expect(extractContentFromChatCompletionResponse(res)).toBe('hello')
  })

  it('safeJsonParse never throws on malformed JSON', () => {
    expect(safeJsonParse('not json')).toBeNull()
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
  })
})

describe('stripModelPreamble', () => {
  it('strips <think> reasoning blocks', () => {
    expect(stripModelPreamble('<think>reasoning here</think>The answer.')).toBe('The answer.')
  })

  it('unwraps a single wrapping markdown code fence', () => {
    expect(stripModelPreamble('```\nCleaned text.\n```')).toBe('Cleaned text.')
  })

  it('drops a "Here is the cleaned text:" preamble line', () => {
    expect(stripModelPreamble('Here is the cleaned text:\nThis is the result.')).toBe(
      'This is the result.'
    )
  })

  it('strips wrapping quotes', () => {
    expect(stripModelPreamble('"quoted output"')).toBe('quoted output')
  })

  it('leaves already-clean text untouched', () => {
    expect(stripModelPreamble('Just clean text.')).toBe('Just clean text.')
  })
})

describe('PCM/WAV encoding', () => {
  it('concatenates chunks in push order', () => {
    const a = new Int16Array([1, 2, 3])
    const b = new Int16Array([4, 5])
    const result = concatInt16([a, b])
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5])
  })

  it('produces a well-formed 44-byte-header WAV buffer', () => {
    const samples = new Int16Array([0, 100, -100, 32767, -32768])
    const buffer = pcm16ToWavBuffer(samples, 16000)

    expect(buffer.length).toBe(44 + samples.length * 2)
    expect(buffer.toString('ascii', 0, 4)).toBe('RIFF')
    expect(buffer.toString('ascii', 8, 12)).toBe('WAVE')
    expect(buffer.toString('ascii', 12, 16)).toBe('fmt ')
    expect(buffer.readUInt16LE(20)).toBe(1) // PCM
    expect(buffer.readUInt16LE(22)).toBe(1) // mono
    expect(buffer.readUInt32LE(24)).toBe(16000) // sample rate
    expect(buffer.readUInt16LE(34)).toBe(16) // bits per sample
    expect(buffer.toString('ascii', 36, 40)).toBe('data')
    expect(buffer.readUInt32LE(40)).toBe(samples.length * 2)

    // Round-trip the sample data back out.
    for (let i = 0; i < samples.length; i++) {
      expect(buffer.readInt16LE(44 + i * 2)).toBe(samples[i])
    }
  })

  it('base64-encodes the WAV buffer', () => {
    const samples = new Int16Array([1, 2, 3])
    const base64 = pcm16ToWavBase64(samples, 16000)
    const decoded = Buffer.from(base64, 'base64')
    expect(decoded).toEqual(pcm16ToWavBuffer(samples, 16000))
  })
})

describe('sliceTrailingWindow', () => {
  it('extracts the full range when chunks exactly cover it', () => {
    const chunks = [new Int16Array([1, 2, 3]), new Int16Array([4, 5, 6])]
    // 6 samples @ 1000Hz = 6ms total, starting at t=0.
    const result = sliceTrailingWindow(chunks, 0, 1000, 0, 6)
    expect(Array.from(result)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('extracts a sub-range spanning a chunk boundary', () => {
    const chunks = [new Int16Array([1, 2, 3]), new Int16Array([4, 5, 6])]
    // Want sample-indices [2,5) i.e. ms [2,5) at 1000Hz - index 2 (value 3,
    // the last sample of chunk 0) through index 4 (value 5, the middle
    // sample of chunk 1).
    const result = sliceTrailingWindow(chunks, 0, 1000, 2, 5)
    expect(Array.from(result)).toEqual([3, 4, 5])
  })

  it('skips leading chunks entirely outside the requested range', () => {
    const chunks = [new Int16Array([1, 2]), new Int16Array([3, 4]), new Int16Array([5, 6])]
    // Want only the last chunk's worth: ms [4,6).
    const result = sliceTrailingWindow(chunks, 0, 1000, 4, 6)
    expect(Array.from(result)).toEqual([5, 6])
  })

  it('clamps a requested start before chunksStartMs up to chunksStartMs', () => {
    const chunks = [new Int16Array([10, 20, 30])]
    // chunks start at t=5ms (a trailing window, not from session start);
    // asking for ms [0, 8) should clamp to what's actually available.
    const result = sliceTrailingWindow(chunks, 5, 1000, 0, 8)
    expect(Array.from(result)).toEqual([10, 20, 30])
  })

  it('returns an empty array for a zero-length or inverted range', () => {
    const chunks = [new Int16Array([1, 2, 3])]
    expect(Array.from(sliceTrailingWindow(chunks, 0, 1000, 2, 2))).toEqual([])
  })

  it('handles a single sample-rate window across many small chunks (realistic worklet-sized chunks)', () => {
    // Simulates ~128ms chunks at 16kHz (2048 samples) - verify a window
    // request spanning several of them stitches together correctly.
    const sampleRate = 16000
    const chunkSamples = 2048
    const chunks = Array.from({ length: 5 }, (_, i) =>
      Int16Array.from({ length: chunkSamples }, (_, j) => i * chunkSamples + j)
    )
    const totalMs = (5 * chunkSamples * 1000) / sampleRate
    const windowStartMs = totalMs - 300 // last 300ms
    const result = sliceTrailingWindow(chunks, 0, sampleRate, windowStartMs, totalMs)
    const expectedStartSample = Math.round((windowStartMs / 1000) * sampleRate)
    const expectedLength = 5 * chunkSamples - expectedStartSample
    expect(result.length).toBe(expectedLength)
    expect(result[0]).toBe(expectedStartSample)
    expect(result[result.length - 1]).toBe(5 * chunkSamples - 1)
  })
})

describe('computeRms', () => {
  it('is 0 for an empty buffer', () => {
    expect(computeRms(new Int16Array([]))).toBe(0)
  })

  it('is 0 for pure digital silence', () => {
    expect(computeRms(new Int16Array(1000))).toBe(0)
  })

  it('is well below full scale for a quiet-but-nonzero buffer', () => {
    const samples = new Int16Array(1000).fill(20)
    expect(computeRms(samples)).toBeCloseTo(20, 5)
  })

  it('is near full scale for a full-amplitude square wave', () => {
    const samples = new Int16Array(1000).fill(32767)
    expect(computeRms(samples)).toBeCloseTo(32767, 0)
  })
})

/**
 * The cleanup prompt's job changed when transcription moved to a dedicated
 * recogniser: it is now handed already-punctuated text, not raw ASR. These
 * pin the properties that keeps honest, because the failure they guard
 * against is silent - the model quietly "improving" a user's wording, which
 * looks like a working feature until you compare it against what was said.
 */
describe('cleanup prompt after the recogniser change', () => {
  const system = (): string =>
    String(buildCleanupRequest({ model: 'e2b', text: 'x' }).messages[0].content)

  it('does not tell the model its input is unpunctuated, which stopped being true', () => {
    // The old opening line - "You are given raw, unpunctuated speech-to-text
    // output" - is the false premise that produced the rewording. Matching
    // the bare phrase is too blunt: the current prompt says the input is
    // *not* raw unpunctuated output, which is the correction, so what has to
    // be absent is the affirmative claim.
    expect(system()).not.toMatch(/given raw,? unpunctuated/i)
    expect(system()).toMatch(/NOT raw unpunctuated/)
  })

  it('states that the input is already punctuated', () => {
    expect(system()).toMatch(/already/i)
    expect(system()).toMatch(/punctuation/i)
  })

  /**
   * The load-bearing line. Asked to "rewrite" text with no defects in it, a
   * model finds something to change; explicitly permitting a no-op is what
   * makes leaving it alone an acceptable answer.
   */
  it('gives the model permission to return the text unchanged', () => {
    expect(system()).toMatch(/unchanged/i)
    expect(system()).toMatch(/verbatim/i)
  })

  it('forbids each rewording actually observed in real dictations', () => {
    const s = system()
    expect(s).toMatch(/contraction/i) // "It's" -> "It is"
    expect(s).toMatch(/synonym/i) // "as" -> "because"
    expect(s).toMatch(/hedge|qualifier/i) // dropped "really", "sort of"
  })

  it('still asks for the disfluency removal that is the actual job', () => {
    const s = system()
    expect(s).toMatch(/filler/i)
    expect(s).toMatch(/false start/i)
  })
})
