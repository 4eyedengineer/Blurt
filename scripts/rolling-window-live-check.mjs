#!/usr/bin/env node
/**
 * Live empirical check for the rolling-window partial-tick design (see
 * scratchpad/perf-review.md §1/§2b and litertBackend.ts's
 * `runPartialTranscription` doc comment): feeds a long audio session through
 * the REAL `LitertBackend` class (bundled at runtime via esbuild, since
 * electron-vite bundles `src/main` into an Electron-dependent artifact - see
 * `scripts/integration-live.mjs`'s doc comment for why this repo re-bundles
 * rather than importing compiled output) against a live `litert-lm serve`
 * instance, paced at roughly real capture rate (~128ms chunks, matching
 * `pcm-worklet-processor.js`'s CHUNK_SIZE=2048 @ 16kHz).
 *
 * Reports every `/v1/chat/completions` request's wall-clock duration and
 * audio payload size over the course of the session, and asserts (PASS/FAIL,
 * exit non-zero on failure):
 *   (a) every partial tick's audio payload stays within
 *       `DEFAULT_PARTIAL_WINDOW_MS` (+ tolerance) regardless of session
 *       length - the direct regression check for "per-tick cost grows with
 *       session length".
 *   (b) partial-tick durations stay roughly flat across the session (later
 *       ticks aren't dramatically slower than earlier ones) - a
 *       CPU-load-dependent soft check, not a hard latency bound.
 *   (c) partials stream continuously (more than a couple of events) and the
 *       final transcript is non-trivial.
 *
 * Usage: node scripts/rolling-window-live-check.mjs <baseUrl> <modelAlias> <wavPath>
 *   e.g. node scripts/rolling-window-live-check.mjs http://127.0.0.1:9379 e2b /path/to/long_16k.wav
 */
import { execSync } from 'child_process'
import { readFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')

const [, , baseUrlArg, modelArg, wavPathArg] = process.argv
const baseUrl = (baseUrlArg ?? 'http://127.0.0.1:9379').replace(/\/+$/, '')
const model = modelArg ?? 'e2b'
const wavPath = wavPathArg

if (!wavPath) {
  console.error(
    'Usage: node scripts/rolling-window-live-check.mjs <baseUrl> <modelAlias> <wavPath>'
  )
  process.exit(2)
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function readWavPcm16(p) {
  const buf = readFileSync(p)
  const sampleRate = buf.readUInt32LE(24)
  const dataStart = 44
  const dataSize = buf.readUInt32LE(40)
  const numSamples = dataSize / 2
  const samples = new Int16Array(numSamples)
  for (let i = 0; i < numSamples; i++) {
    samples[i] = buf.readInt16LE(dataStart + i * 2)
  }
  return { samples, sampleRate }
}

let failures = 0
function report(name, ok, detail) {
  const status = ok ? 'PASS' : 'FAIL'
  console.log(`[${status}] ${name}${detail ? ` - ${detail}` : ''}`)
  if (!ok) failures++
}

async function main() {
  const tmpDir = mkdtempSync(path.join(tmpdir(), 'litert-rolling-window-check-'))
  const bundlePath = path.join(tmpDir, 'litertBackend.bundle.mjs')

  console.log(`Bundling src/main/backend/litertBackend.ts -> ${bundlePath}`)
  execSync(
    `node -e "require('esbuild').buildSync({entryPoints:['${path.join(
      REPO_ROOT,
      'src/main/backend/litertBackend.ts'
    )}'], outfile:'${bundlePath}', bundle:true, platform:'node', format:'esm', target:'node18'})"`,
    { cwd: REPO_ROOT, stdio: 'inherit' }
  )

  try {
    await runCheck(bundlePath)
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log('---')
  console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

async function runCheck(bundlePath) {
  const { LitertBackend, DEFAULT_PARTIAL_WINDOW_MS } = await import(bundlePath)
  const { samples, sampleRate } = readWavPcm16(wavPath)
  const totalDurationMs = (samples.length / sampleRate) * 1000
  console.log(
    `Target: ${baseUrl}, model alias: ${model}, wav: ${wavPath} (${(totalDurationMs / 1000).toFixed(1)}s)`
  )
  console.log('---')

  const realFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    const start = Date.now()
    let audioMs = null
    try {
      const body = JSON.parse(init.body)
      const parts = body.messages?.[0]?.content
      const audioPart = Array.isArray(parts) ? parts.find((p) => p.type === 'input_audio') : null
      if (audioPart) {
        const wavBytes = Buffer.from(audioPart.input_audio.data, 'base64').length
        audioMs = ((wavBytes - 44) / 2 / sampleRate) * 1000
      }
    } catch {
      // not every request necessarily carries an audio part
    }
    const res = await realFetch(url, init)
    await res
      .clone()
      .arrayBuffer()
      .catch(() => {})
    requests.push({ durationMs: Date.now() - start, audioMs })
    return res
  }

  const backend = new LitertBackend({ getBaseUrl: () => baseUrl, modelId: model })
  const partialEvents = []
  backend.onPartialTranscript((_sid, text) => partialEvents.push(text))
  backend.onError((_sid, err) => console.error('backend error:', err))

  const sessionId = await backend.startSession({ sampleRate })
  const chunkSamples = 2048 // ~128ms @ 16kHz, matches pcm-worklet-processor.js
  const chunkMs = (chunkSamples / sampleRate) * 1000
  let offset = 0
  while (offset < samples.length) {
    const end = Math.min(offset + chunkSamples, samples.length)
    backend.pushAudio(sessionId, samples.subarray(offset, end))
    offset = end
    await sleep(chunkMs)
  }

  const finalText = await backend.endSession(sessionId)
  globalThis.fetch = realFetch

  console.log(`Requests: ${requests.length}, partial events: ${partialEvents.length}`)
  console.log('idx\tdurationMs\taudioMs')
  requests.forEach((r, i) =>
    console.log(`${i}\t${r.durationMs}\t${r.audioMs === null ? 'n/a' : Math.round(r.audioMs)}`)
  )

  // The final endSession pass is intentionally a full-buffer request (not
  // windowed) - exclude it from the "bounded window" and "flat cost" checks
  // below, it's the one deliberate exception (see litertBackend.ts's
  // endSession doc comment).
  const finalIsFullBuffer = requests.length > 0 && requests[requests.length - 1].audioMs !== null
  const partialTicks = finalIsFullBuffer ? requests.slice(0, -1) : requests

  const windowTolerance = DEFAULT_PARTIAL_WINDOW_MS + 500
  const oversized = partialTicks.filter((r) => r.audioMs !== null && r.audioMs > windowTolerance)
  report(
    '(a) every partial tick stays within the rolling window budget',
    oversized.length === 0,
    `window=${DEFAULT_PARTIAL_WINDOW_MS}ms, tolerance=${windowTolerance}ms, oversized=${oversized.length}/${partialTicks.length}`
  )

  const durations = partialTicks.map((r) => r.durationMs)
  const firstAvg = average(durations.slice(0, Math.max(1, Math.ceil(durations.length / 4))))
  const lastAvg = average(durations.slice(-Math.max(1, Math.ceil(durations.length / 4))))
  const ratio = lastAvg / firstAvg
  report(
    '(b) partial-tick duration stays roughly flat across the session (not growing with T)',
    ratio < 2.5,
    `first-quartile avg=${firstAvg.toFixed(0)}ms, last-quartile avg=${lastAvg.toFixed(0)}ms, ratio=${ratio.toFixed(2)}x`
  )

  report(
    '(c) partials streamed continuously and the final transcript is non-trivial',
    partialEvents.length > 1 && finalText.trim().length > 20,
    `partial events=${partialEvents.length}, final transcript length=${finalText.trim().length}`
  )
}

function average(arr) {
  return arr.length === 0 ? 0 : arr.reduce((a, b) => a + b, 0) / arr.length
}

main().catch((err) => {
  console.error('Fatal error running rolling-window live check:', err)
  process.exit(1)
})
