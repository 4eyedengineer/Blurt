#!/usr/bin/env node
/**
 * Live end-to-end integration check against a REAL `litert-lm serve`
 * instance (not the mock backend, no fakes). Plain Node, no build step -
 * intentionally re-implements the exact request shapes/constants/parsing
 * logic from src/main/backend/litertWire.ts (see that file for the
 * authoritative version the app actually ships) rather than importing the
 * compiled output, since electron-vite bundles src/main into a single
 * artifact alongside `electron`-dependent modules that can't load outside
 * Electron. Every prompt string / SSE-parsing routine here is a byte-for-
 * byte copy of litertWire.ts, so a pass here is a real signal about wire
 * compatibility - drift between the two should be treated as a bug in
 * whichever one didn't get updated.
 *
 * Usage: node scripts/integration-live.mjs <baseUrl> <modelAlias> <wavPath>
 *   e.g. node scripts/integration-live.mjs http://127.0.0.1:9421 e2b /path/to/test_clean_16k.wav
 *
 * Exits non-zero if any step fails or produces an empty/garbage result.
 */
import { readFileSync } from 'fs'

const [, , baseUrlArg, modelArg, wavPathArg] = process.argv
const baseUrl = (baseUrlArg ?? 'http://127.0.0.1:9421').replace(/\/+$/, '')
const model = modelArg ?? 'e2b'
const wavPath = wavPathArg

if (!wavPath) {
  console.error('Usage: node scripts/integration-live.mjs <baseUrl> <modelAlias> <wavPath>')
  process.exit(2)
}

// ---------------------------------------------------------------------------
// Verbatim copies of the constants/logic from src/main/backend/litertWire.ts
// ---------------------------------------------------------------------------

const TRANSCRIPTION_PROMPT =
  'Transcribe the following audio verbatim, exactly as spoken. Output only the raw transcription text - no commentary, no preamble, no quotation marks, no markdown formatting.'

const CLEANUP_SYSTEM_PROMPT = `You are a dictation cleanup assistant, in the style of Google's Eloquent app. You are given raw, unpunctuated speech-to-text output. Rewrite it into clean, readable text by:
- Removing filler words (um, uh, erm, like, you know) that are not meaningful content.
- Removing false starts, self-corrections, and repeated words/phrases (e.g. "I want- I want to go" -> "I want to go"; keep only the corrected version).
- Adding correct capitalization and punctuation.
- Preserving the speaker's meaning, wording, and tone otherwise - do not paraphrase, summarize, or add information.
Output ONLY the cleaned text. No preamble, no explanation, no quotation marks, no markdown.`

const KEYPOINTS_PROMPT =
  'Rewrite the following text as a concise bullet-point summary of its key points, one bullet per point, using "- " as the bullet marker. Output ONLY the bullet list, nothing else.'

function buildWarmupRequest(model) {
  return { model, stream: false, temperature: 0, messages: [{ role: 'user', content: 'Hi' }] }
}

function buildTranscriptionRequest(model, wavBase64) {
  return {
    model,
    stream: true,
    temperature: 0,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIPTION_PROMPT },
          { type: 'input_audio', input_audio: { data: wavBase64, format: 'wav' } }
        ]
      }
    ]
  }
}

function buildCleanupRequest(model, text) {
  return {
    model,
    stream: true,
    temperature: 0.2,
    messages: [
      { role: 'system', content: CLEANUP_SYSTEM_PROMPT },
      { role: 'user', content: text }
    ]
  }
}

function buildKeypointsRequest(model, text) {
  return {
    model,
    stream: true,
    temperature: 0.3,
    messages: [
      { role: 'system', content: KEYPOINTS_PROMPT },
      { role: 'user', content: text }
    ]
  }
}

function parseSSEBuffer(buffer) {
  const normalized = buffer.replace(/\r\n/g, '\n')
  const parts = normalized.split('\n\n')
  const remainder = parts.pop() ?? ''
  const events = []
  for (const part of parts) {
    if (!part.trim()) continue
    const dataLines = []
    for (const line of part.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
    }
    if (dataLines.length > 0) events.push({ data: dataLines.join('\n') })
  }
  return { events, remainder }
}

function isStreamDone(rawData) {
  return rawData.trim() === '[DONE]'
}

function safeJsonParse(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function extractDeltaFromChatCompletionChunk(json) {
  const delta = json?.choices?.[0]?.delta?.content
  if (typeof delta === 'string') return delta
  const full = json?.choices?.[0]?.message?.content
  if (typeof full === 'string') return full
  return null
}

function extractContentFromChatCompletionResponse(json) {
  const content = json?.choices?.[0]?.message?.content
  return typeof content === 'string' ? content : null
}

const PREAMBLE_LINE_PATTERN =
  /^(here('s| is)|sure[,!]?|certainly[,!]?|okay[,!]?|of course[,!]?)\b.*[:-]\s*$/i

function stripModelPreamble(text) {
  let out = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim()
  const fenceMatch = out.match(/^```[a-zA-Z0-9]*\n([\s\S]*?)\n?```$/)
  if (fenceMatch) out = fenceMatch[1].trim()
  const lines = out.split('\n')
  if (lines.length > 1 && PREAMBLE_LINE_PATTERN.test(lines[0].trim())) {
    lines.shift()
    out = lines.join('\n').trim()
  }
  if (out.length >= 2 && out.startsWith('"') && out.endsWith('"')) out = out.slice(1, -1).trim()
  return out
}

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

/** Mirrors Sidecar.pingOnce() in src/main/backend/sidecar.ts exactly (2s timeout, GET /v1/models, res.ok). */
async function healthCheck() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2000)
  try {
    const res = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

/** Mirrors LitertBackend.chatCompletion() in src/main/backend/litertBackend.ts. */
async function chatCompletion(body) {
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`HTTP ${res.status}${text ? `: ${text.slice(0, 300)}` : ''}`)
  }
  const contentType = res.headers.get('content-type') ?? ''
  if (!contentType.includes('text/event-stream') || !res.body) {
    const json = safeJsonParse(await res.text())
    const content = json ? extractContentFromChatCompletionResponse(json) : null
    if (content === null) throw new Error('Could not parse non-streaming response as JSON')
    return content
  }
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffered = ''
  let full = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const { events, remainder } = parseSSEBuffer(buffered)
    buffered = remainder
    for (const evt of events) {
      if (isStreamDone(evt.data)) continue
      const json = safeJsonParse(evt.data)
      if (json === null) continue
      const delta = extractDeltaFromChatCompletionChunk(json)
      if (delta) full += delta
    }
  }
  return full
}

// ---------------------------------------------------------------------------
// Test steps
// ---------------------------------------------------------------------------

let failures = 0

function report(name, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  console.log(`Target: ${baseUrl}, model alias: ${model}`)
  console.log('---')

  // (a) Health check, as implemented in sidecar.ts's pingOnce().
  const t0 = Date.now()
  const healthy = await healthCheck()
  report('(a) health check GET /v1/models', healthy, `${Date.now() - t0}ms`)

  // Warmup (buildWarmupRequest) - not one of the 5 required steps but
  // exercises litertWire.ts's warmup builder and avoids the first real
  // step below silently eating the ~5s cold-load cost.
  const tw = Date.now()
  try {
    const warmupReply = await chatCompletion(buildWarmupRequest(model))
    console.log(`  (warmup reply: ${JSON.stringify(warmupReply)}, ${Date.now() - tw}ms)`)
  } catch (err) {
    console.log(`  (warmup failed, continuing: ${err.message})`)
  }

  // (b) SSE streaming text completion.
  const tb = Date.now()
  try {
    const reply = await chatCompletion({
      model,
      stream: true,
      messages: [{ role: 'user', content: 'Count from one to five, one number per line.' }]
    })
    const ok = /1/.test(reply) && reply.trim().length > 0
    report(
      '(b) SSE streaming text completion',
      ok,
      `${Date.now() - tb}ms, reply: ${JSON.stringify(reply)}`
    )
  } catch (err) {
    report('(b) SSE streaming text completion', false, err.message)
  }

  // (c) Transcription of the piper speech WAV via the real request builder.
  const tc = Date.now()
  try {
    const wavBase64 = readFileSync(wavPathArg).toString('base64')
    const raw = await chatCompletion(buildTranscriptionRequest(model, wavBase64))
    const transcript = stripModelPreamble(raw)
    const ok = transcript.toLowerCase().includes('quick brown fox')
    report(
      '(c) transcription of piper speech WAV',
      ok,
      `${Date.now() - tc}ms, transcript: ${JSON.stringify(transcript)}`
    )
  } catch (err) {
    report('(c) transcription of piper speech WAV', false, err.message)
  }

  // (d) Cleanup prompt on a filler-word sentence (text-only, matches
  // LitertBackend.cleanup()'s real call path - post-transcription cleanup,
  // not audio input).
  const td = Date.now()
  try {
    const fillerText = 'um so like I think we should uh go to the store today you know'
    const raw = await chatCompletion(buildCleanupRequest(model, fillerText))
    const cleaned = stripModelPreamble(raw)
    const ok = cleaned.length > 0 && !/\bum\b|\buh\b/i.test(cleaned) && /store/i.test(cleaned)
    report(
      '(d) cleanup prompt on filler-word sentence',
      ok,
      `${Date.now() - td}ms, cleaned: ${JSON.stringify(cleaned)}`
    )
  } catch (err) {
    report('(d) cleanup prompt on filler-word sentence', false, err.message)
  }

  // (e) Keypoints transform.
  const te = Date.now()
  try {
    const longText =
      'The history of the printing press begins in the fifteenth century, when Johannes Gutenberg introduced movable type to Europe. This innovation dramatically reduced the cost of producing books and accelerated the spread of literacy. Over the following centuries, printing technology continued to evolve, eventually giving rise to the modern newspaper and mass media industry.'
    const raw = await chatCompletion(buildKeypointsRequest(model, longText))
    const bullets = stripModelPreamble(raw)
    const ok = bullets.split('\n').filter((l) => l.trim().startsWith('-')).length >= 2
    report('(e) keypoints transform', ok, `${Date.now() - te}ms, bullets:\n${bullets}`)
  } catch (err) {
    report('(e) keypoints transform', false, err.message)
  }

  console.log('---')
  console.log(failures === 0 ? 'ALL STEPS PASSED' : `${failures} STEP(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('Fatal error running integration script:', err)
  process.exit(1)
})
