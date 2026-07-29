import { describe, expect, it } from 'vitest'
import {
  buildCleanupRequest,
  buildTranscriptionRequest,
  buildTransformRequest,
  buildVoiceEditRequest,
  computeRms,
  concatInt16,
  extractContentFromChatCompletionResponse,
  extractDeltaFromChatCompletionChunk,
  isStreamDone,
  parseSSEBuffer,
  pcm16ToWavBase64,
  pcm16ToWavBuffer,
  safeJsonParse,
  stripModelPreamble
} from './litertWire'

describe('request builders', () => {
  it('builds a transcription request with an input_audio content part', () => {
    const req = buildTranscriptionRequest({ model: 'gemma-4-e2b', wavBase64: 'QUJD' })
    expect(req.model).toBe('gemma-4-e2b')
    expect(req.stream).toBe(true)
    expect(Array.isArray(req.messages[0].content)).toBe(true)
    const parts = req.messages[0].content as Array<Record<string, unknown>>
    const audioPart = parts.find((p) => p.type === 'input_audio')
    expect(audioPart).toMatchObject({ input_audio: { data: 'QUJD', format: 'wav' } })
  })

  it('includes a vocabulary hint when custom vocabulary is provided', () => {
    const req = buildTranscriptionRequest({
      model: 'gemma-4-e2b',
      wavBase64: 'QUJD',
      vocabulary: ['Kubernetes', 'Eloquent']
    })
    const parts = req.messages[0].content as Array<{ type: string; text?: string }>
    const textPart = parts.find((p) => p.type === 'text')
    expect(textPart?.text).toContain('Kubernetes')
    expect(textPart?.text).toContain('Eloquent')
  })

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
