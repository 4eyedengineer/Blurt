# Contributing to Blurt

This is the contributor entry point: how to run Blurt in dev, how the pieces fit together, how to
run tests/lint/typecheck, and how to build the installer. For the end-user README, see
[README.md](README.md). For the Windows-specific build/run/GPU how-to, see [WINDOWS.md](WINDOWS.md).

## Development setup

```sh
npm install
npm run dev          # electron-vite dev server + Electron, with HMR
```

`npm run dev` starts the app in dev mode against whatever backend settings are already saved (or
the defaults, on a fresh checkout). It does not install Python or a `litert-lm` runtime for you -
see [WINDOWS.md](WINDOWS.md) for the full from-source Windows setup (Python, `litert-lm`, model
import) if you need a real backend running while developing.

Other useful scripts:

```sh
npm run typecheck    # tsc --noEmit for both the node (main/preload) and web (renderer) tsconfigs
npm run lint         # eslint (flat config, includes prettier + react-hooks rules)
npm run format       # prettier --write .
npm test             # vitest - unit tests, see "Tests" below
npm run build        # typecheck, then electron-vite build (main + preload + renderer)
npm run build:win    # build, then electron-builder --win (NSIS installer + portable exe)
npm run build:unpack # build, then electron-builder --dir (unpacked app dir, no installer/exe)
```

### Environment note: Rollup on old glibc

If you're developing in a container with glibc older than 2.32, Rollup 4's prebuilt native binary
will fail to load with `ERR_DLOPEN_FAILED`. `package.json` pins an `overrides` entry redirecting
`rollup` to `@rollup/wasm-node` (a WASM build of the same version, no native addon) so
`npm install && npm run build` works there anyway. On a normal Windows/macOS/modern-Linux machine
this override is harmless but unnecessary.

### Developing under WSL/Linux

The renderer and the LiteRT-LM backend both run fine under WSL2 with WSLg (a graphical WSL2
environment - check for `DISPLAY`/`WAYLAND_DISPLAY` env vars and `/mnt/wslg`), which is useful for
UI and backend work without a Windows host. Two things to know:

- **Sandbox helper permissions.** A plain `npm install` doesn't leave
  `node_modules/electron/dist/chrome-sandbox` setuid-root, which Electron's sandbox needs. If the
  window fails to open with a sandbox-related error, either fix the permissions
  (`sudo chown root:root chrome-sandbox && sudo chmod 4755 chrome-sandbox` in that directory) or
  run dev mode with the sandbox disabled: `npm run dev -- --no-sandbox`.
- **Microphone.** WSLg exposes an audio bridge (a PulseAudio source named `RDPSource`), but whether
  it reliably carries a real physical microphone through to Chromium's `getUserMedia()` inside
  Electron has not been established either way here. Treat WSL as good enough for UI/backend
  development, and use a real Windows host (see [WINDOWS.md](WINDOWS.md)) for dictation you
  actually trust to capture real speech.
- GPU acceleration needs a real Vulkan/D3D12-capable adapter, which a WSL2/WSLg sandbox does not
  expose - the backend falls back to CPU automatically in that case (see "The real backend:
  LiteRT-LM" below), the same as it would on any machine without a usable GPU.

## Tests

`npm test` runs Vitest across the pure/dependency-injected logic that doesn't need a native module
or a live sidecar:

- `litertWire.test.ts` - request builders, SSE/JSON response parsing, WAV encoding
- `sidecar.test.ts` - managed-command templating, port-guard/stale-process decisions, readiness
  and GPU-fallback-marker logic
- push-to-talk's key-map/debounce/controller logic and WSL detection
- the push-to-talk overlay's phase reducer
- `wordDiff.test.ts` - the word-diff used for the cleanup reveal

## Project layout

```
src/
  shared/                  Code shared between main and renderer (types, IPC channel names,
                            the InferenceBackend contract). No Electron/Node/DOM APIs here.
    backend.ts                InferenceBackend interface + wire types + BackendStatus/BackendError
    types.ts                  Settings (incl. backend/sidecar config), DictationEntry, etc.
    models.ts                  Model catalog (HF repo per ModelId) + download-progress types
    ipc-channels.ts           Centralized IPC channel name constants

  main/                     Electron main process (Node context)
    index.ts                  App bootstrap: creates the window, wires backend controller +
                               model manager + stores + IPC, registers the global hotkey
    hotkey.ts                  globalShortcut register/unregister helper
    overlay.ts                 Creates/positions the push-to-talk overlay BrowserWindow
    overlayController.ts       State machine: PushToTalkController events -> overlay IPC ->
                               clipboard/paste injection - see Push-to-talk overlay below
    paste.ts                   clipboard.writeText + platform-specific Ctrl+V injection
    wsl.ts                      /proc/version-based WSL detection (explains PTT limitations)
    runtime/
      venvResolver.ts           Resolves the packaged app's self-managed Python venv location
      firstRunSetup.ts          Finds Python 3.10+, creates the venv, pip-installs litert-lm
      setupWindow.ts            The first-run setup screen shown while that runs
    pushToTalk/
      keyMap.ts                 Key-id <-> uiohook keycode table, debounce predicate (pure)
      uiohookLoader.ts           Defensive `require('uiohook-napi')` - never throws
      pushToTalkController.ts    Wraps uiohook keydown/keyup into hold-start/hold-end/
                                 accidental-tap events
    backend/
      litertWire.ts             Pure request builders + SSE/JSON response parsers + WAV encoder
                                 for the LiteRT-LM sidecar's wire protocol - see below
      litertBackend.ts          InferenceBackend backed by a LiteRT-LM sidecar (HTTP/SSE)
      streamThrottle.ts          ThrottledTextEmitter: batches a growing streamed-text callback
                                 down to ~100ms ticks - see "Streaming partials" below
      sidecar.ts                 Spawns/monitors the litert-lm serve process (or points at an
                                 external one), health-checks it, restarts with backoff
      portGuard.ts                Refuses to spawn a managed sidecar on a port a foreign,
                                 unidentified process already occupies
      gpuWrapperPath.ts           Resolves the absolute path to resources/serve_gpu.py, in dev
                                 and packaged builds alike
      modelManager.ts            Downloads .litertlm models from HuggingFace, tracks progress
      backendController.ts       Builds the active InferenceBackend from settings and hot-swaps
                                 it when backend/model/sidecar settings change
    store/
      jsonStore.ts               Tiny generic JSON-file-backed store
      historyStore.ts            Dictation history persisted to userData/history.json
      settingsStore.ts           App settings persisted to userData/settings.json
    ipc/
      backendIpc.ts               Wires the active InferenceBackend <-> ipcMain (re-attaches
                                   listeners across hot-swaps), status + session-error events
      historyIpc.ts               Wires HistoryStore <-> ipcMain
      settingsIpc.ts               Wires SettingsStore <-> ipcMain (+ re-registers hotkey,
                                   triggers a backend rebuild on backend-relevant changes)
      modelManagerIpc.ts           Wires ModelManager (list/download/cancel/remove) <-> ipcMain
      pushToTalkIpc.ts             Exposes PushToTalkStatus (available/reason/isWSL/xdotool) to Settings

  preload/                  contextBridge boundary
    index.ts                  Exposes a typed `window.api` (dictation / history / settings /
                               hotkey / models / pushToTalk / overlay)
    index.d.ts                 Global Window typing for `window.api`

  renderer/                 The React app
    public/
      pcm-worklet-processor.js  AudioWorkletProcessor (plain JS, runs in its own global scope -
                                 see comments in the file for why it's not bundled)
    src/
      App.tsx                   Tab shell (Dictate / History / Settings)
      main.tsx                   Renderer entry point - also routes to OverlayApp when loaded
                                 with a `#overlay` hash (see Push-to-talk overlay below)
      context/SettingsContext.tsx
      hooks/
        useAudioCapture.ts       Mic capture: AudioWorklet 16kHz PCM16 only, fails visibly if unavailable
        useDictationSession.ts   Orchestrates record -> cleanup -> transform -> history lifecycle
        useBackendStatus.ts      Subscribes to the header status pill's backend state
        useModelManager.ts       Drives the Settings screen's model download UI
      screens/                 DictateScreen, HistoryScreen, SettingsScreen
      components/              RecordButton, TransformBar, StatsBar, VoiceEditBar, Sidebar,
                               StatusPill, Toggle, Icons, MicLevelMeter, DiffReveal (word-diff
                               reveal shown after cleanup/voice-edit - see below)
      overlay/                 Push-to-talk overlay window's React tree (loaded via `#overlay`)
        overlayState.ts          Pure phase reducer (idle/recording/cleaning/revealing/done) -
                                 unit-tested
        useOverlayPushToTalk.ts  Wires main-process ptt-* IPC to useAudioCapture + dictation IPC
        OverlayApp.tsx           The pill itself: dot, mic level, live/final transcript, status
      lib/                     format.ts (word count / WPM / byte formatting), clipboard.ts,
                               wordDiff.ts (pure LCS word-diff - see below), readyTone.ts (the
                               push-to-talk "mic is live" tone)
```

## The `InferenceBackend` contract

Everything the app needs from "the AI" goes through one interface, defined in
`src/shared/backend.ts`:

```ts
export type AudioChunk = Int16Array | Buffer
export type TransformMode = 'keypoints' | 'formal' | 'short' | 'long'

export interface StartSessionOptions {
  sampleRate?: number
  language?: string
  vocabulary?: string[]
}

export interface InferenceBackend {
  startSession(opts?: StartSessionOptions): Promise<string>
  pushAudio(sessionId: string, chunk: AudioChunk): void
  endSession(sessionId: string): Promise<string>
  onPartialTranscript(listener: (sessionId: string, text: string) => void): () => void
  // `operationId`, if given, streams incremental progress via onTextStreamProgress below -
  // see "Streaming partials + the cleanup diff-reveal" further down.
  cleanup(text: string, operationId?: string): Promise<string>
  transform(text: string, mode: TransformMode, operationId?: string): Promise<string>
  voiceEdit(text: string, command: string, operationId?: string): Promise<string>
  onTextStreamProgress(listener: (operationId: string, text: string) => void): () => void
}
```

This interface only ever runs in the **main process**. The renderer never touches it directly -
it goes through the typed IPC bridge in `src/preload/index.ts` (`window.api.dictation.*`), which
is wired to the concrete backend instance in `src/main/ipc/backendIpc.ts`.

`LitertBackend` (`src/main/backend/litertBackend.ts`) is the only implementation, built and
(re)constructed by `BackendController` (`src/main/backend/backendController.ts`) whenever
model/sidecar settings change - see "The real backend: LiteRT-LM" below. If it fails to start (bad
sidecar command, model not downloaded, sidecar crashed past its restart budget, ...),
`BackendController` swaps in `UnavailableBackend` (defined alongside it) - every method rejects
with a clear message rather than silently degrading to fake output, so the status pill and any
in-flight call both surface the failure honestly.

The renderer captures 16kHz mono PCM16 via an AudioWorklet - no fallback path; if it's unavailable,
capture fails visibly instead - and forwards raw chunks over IPC as `AudioChunkPayload`
(`{ buffer, sampleRate }`), which `backendIpc.ts` converts to `Int16Array` before calling
`pushAudio`.

## Streaming partials + the cleanup diff-reveal

Two UX refinements sit on top of the base `InferenceBackend` contract, both implemented by
`LitertBackend`:

- **Real-time streaming partials, over a bounded rolling window.** `LitertBackend.pushAudio` fires
  a partial re-transcription tick every `DEFAULT_PARTIAL_INTERVAL_MS` (1.5s) of new audio, and each
  tick streams its result in over the sidecar's SSE response as tokens arrive (via
  `ThrottledTextEmitter`, `src/main/backend/streamThrottle.ts`) instead of waiting for the whole
  re-transcription to finish and emitting once. A partial tick does **not** re-transcribe the
  entire accumulated buffer - per-tick cost would otherwise grow linearly with session length.
  Instead, each tick only sends a bounded trailing **window** (`DEFAULT_PARTIAL_WINDOW_MS`, ~4s) of
  audio, overlapping the previous window by `DEFAULT_PARTIAL_WINDOW_OVERLAP_MS` (~0.8s) so a word
  cut off at the boundary gets a full second chance to be heard whole.
  `src/main/backend/transcriptStitcher.ts`'s `stitchTranscript` (pure, unit-tested) then finds the
  repeated words at that overlap and dedupes them, so the _displayed_ text is always the full
  transcript-so-far - text from earlier windows is "committed" (fixed) once a later window's start
  advances past it, similar to streaming-ASR "confirm on agreement" designs. This keeps every
  tick's request cost roughly flat regardless of dictation length, at the cost of occasional
  live-only seam artifacts, which `endSession`'s final pass (below) is unaffected by. A **spiral
  guard** (`src/main/backend/partialTickScheduler.ts`'s `shouldLaunchPartialTick`, pure + unit-
  tested with an injectable clock) also enforces a minimum real-world idle gap
  (`DEFAULT_MIN_PARTIAL_IDLE_GAP_MS`, 300ms) between a tick completing and the next one launching -
  without it, a backlog of "new audio arrived while the last tick was still running" would launch
  the next tick with zero breathing room, pegging the CPU with back-to-back requests on slow
  hardware. Emits are throttled to ~100ms batches (`streamThrottleMs`) so a fast token stream
  doesn't spam IPC. `endSession`'s final pass streams the same way, over the same
  `onPartialTranscript`/`'partial'` event. `cleanup`/`transform`/`voiceEdit` stream too, but via a
  separate, more generic mechanism: the caller mints an `operationId` (any string; the renderer
  uses `crypto.randomUUID()`), passes it as each method's optional last argument, and subscribes to
  `onTextStreamProgress`/the `backend:text-stream-progress` IPC event, filtering on that id.
  `useDictationSession` (`src/renderer/src/hooks/useDictationSession.ts`) uses this to show a
  live-growing preview while cleanup/transform are in flight, with a blinking caret
  (`.stream-caret` in `DictateScreen.css`) and a subtle shimmer before the first chunk arrives.
- **Inline-edit reveal on cleanup.** Rather than swapping straight from the raw transcript to the
  cleaned text, `useDictationSession.stopRecording` computes a word-level diff
  (`src/renderer/src/lib/wordDiff.ts`, `diffWords(rawTranscript, cleanedText)`) and shows it inline
  via `<DiffReveal>` (`src/renderer/src/components/DiffReveal.tsx`) for ~2s: removed words
  (fillers, false starts) strike through and fade to transparent, inserted/changed words highlight
  and fade, then it settles to the plain cleaned text. `applyVoiceEdit` gets a shorter (~1.2s)
  version of the same treatment. Critically, this delay is **purely visual** - `displayText`,
  history persistence, and auto-copy-on-cleanup all happen immediately once cleanup resolves; only
  the on-screen reveal lingers. `wordDiff.ts` is a pure LCS-based diff over whitespace-tokenized
  words: matching is case-insensitive with punctuation stripped, and it's unit-tested in
  `wordDiff.test.ts` (pure deletions, insertions, replacements, identical text, empty inputs). The
  push-to-talk overlay gets a lighter version of the same idea: `overlayState.ts` has a
  `'revealing'` phase between `'cleaning'` and `'done'` that shows the diff inline in the pill for
  ~1.5s (`useOverlayPushToTalk.ts`'s `REVEAL_SETTLE_MS`) - the clipboard copy/paste fires
  immediately on cleanup completion (`window.api.overlay.sendResult`), never delayed by the reveal.

## The real backend: LiteRT-LM

`LitertBackend` (`src/main/backend/litertBackend.ts`) implements `InferenceBackend` by talking to
[Google's LiteRT-LM runtime](https://github.com/google-ai-edge/LiteRT-LM), run out-of-process as
`litert-lm serve` - an OpenAI-compatible HTTP/SSE server. Blurt spawns/talks to it rather than
re-implementing an FFI binding.

### Architecture

```
Settings (modelId, sidecar.*)
        |
        v
BackendController (src/main/backend/backendController.ts)
  - reads settings, builds/rebuilds LitertBackend (or UnavailableBackend on failure)
  - owns the current Sidecar + LitertBackend, hot-swaps on settings changes
  - exposes getStatus()/'status' events -> header status pill
        |
        v
Sidecar (src/main/backend/sidecar.ts)          ModelManager (src/main/backend/modelManager.ts)
  - 'managed': spawns `litert-lm serve ...`      - resolves + downloads .litertlm files from
    from a configurable command template           HuggingFace, tracks progress, lists installed
  - 'external': just points at a URL you gave it   models
  - polls GET /v1/models until ready, restarts
    a managed process with backoff on crash
        |
        v
LitertBackend (src/main/backend/litertBackend.ts)
  - accumulates PCM16 audio per session, periodically re-transcribes a bounded trailing WINDOW of
    it (partial transcripts, stitched against earlier windows) and re-transcribes the whole buffer
    once on endSession (final transcript)
  - cleanup/transform/voiceEdit as chat-completions prompts
  - all wire-format assumptions isolated in:
litertWire.ts (pure, unit-tested)
  - request builders: buildTranscriptionRequest / buildCleanupRequest / buildTransformRequest /
    buildVoiceEditRequest / buildWarmupRequest
  - response parsing: parseSSEBuffer, extractDeltaFromChatCompletionChunk,
    extractContentFromChatCompletionResponse, stripModelPreamble
  - audio encoding: concatInt16, sliceTrailingWindow, pcm16ToWavBuffer/Base64, buildSilentWavBase64
transcriptStitcher.ts (pure, unit-tested) - stitchTranscript: merges committed + window text
partialTickScheduler.ts (pure, unit-tested) - shouldLaunchPartialTick: spiral-guard tick gating
```

Because the exact request/response shape of a given `litert-lm serve` build can vary, **every**
wire-format assumption lives in `litertWire.ts` as small pure functions - nothing else in the app
touches JSON/SSE shapes directly. If a real server disagrees with an assumption here, only this one
file needs to change; `src/main/backend/litertWire.test.ts` covers it with unit tests (`npm test`).

### What it assumes about the sidecar

Verified against a real `litert-lm` 0.14.0 pip install and a real Gemma 4 E2B model:

- `POST /v1/chat/completions`, OpenAI-compatible, `stream: true` giving SSE
  (`text/event-stream`) `chat.completion.chunk`-shaped events, terminated by a `data: [DONE]`
  event. If the sidecar instead returns a normal JSON body (non-SSE), `litertBackend.ts` falls
  back to parsing that directly (see `extractContentFromChatCompletionResponse`).
- Audio is sent as a user-message content part:
  `{ type: 'input_audio', input_audio: { data: '<base64 wav>', format: 'wav' } }`, alongside a
  `{ type: 'text', text: '<transcription prompt>' }` part. The `format` field is read but never
  validated - the engine just requires `data` to decode to a real RIFF/WAV container (any declared
  sample rate works; no client-side resampling needed), and headerless raw PCM16 silently returns
  `content: null` (HTTP 200, no error) rather than failing loudly - `pcm16ToWavBuffer` always emits
  a proper WAV header for exactly this reason.
- `GET /v1/models` is used purely as a "is the server up yet" health check - it responds within
  ~1-2s of process start, well before the model is actually loaded into memory (loading is lazy, on
  the first real inference request - see `buildWarmupRequest` below).
- No `usage`/token-count field appears in any response, streamed or not.
- The reference server (`http.server.HTTPServer`, not `ThreadingHTTPServer`) is single-threaded - a
  second concurrent request just blocks on the TCP accept until the first fully completes.
  `LitertBackend` funnels every outgoing request through one serial promise-chain queue for this
  reason rather than assuming the sidecar can service overlapping calls.
- Model selection is per-request via the JSON body's `"model"` field, but that field must be the
  **alias** the model was registered under via `litert-lm import <file> <alias>` (see
  `ModelCatalogEntry.alias` in `src/shared/models.ts`) - not this app's own `ModelId` (e.g.
  `"gemma-4-e2b"`). `serve` itself takes no model-selection flag at all; `BackendController`
  resolves the alias and imports the model (via `ModelManager.importModel`) before starting the
  sidecar if it hasn't been already.
- `buildWarmupRequest` (`litertWire.ts`) builds a minimal throwaway completion used to force the
  lazy model load to happen right after the sidecar comes up (`LitertBackend.warmup()`, fired by
  `BackendController` once the sidecar is ready) instead of on the user's first real utterance. The
  warmup request includes a tiny (~0.3s) silent `input_audio` part alongside its text part, not
  just text - the audio submodel appears to load lazily and separately from the text backbone, so a
  text-only warmup left it cold for the user's first real dictation.

### Session lifecycle mapping

- `startSession` allocates an in-memory buffer for the session's PCM16 audio (no request to the
  sidecar yet), plus a small rolling "recent audio" buffer used for partial ticks.
- `pushAudio` appends to both buffers. Once ~1.5 seconds of _new_ audio has accumulated (and the
  spiral-guard idle gap has elapsed since the last tick completed), a partial tick fires: only a
  bounded trailing window of audio (`DEFAULT_PARTIAL_WINDOW_MS`, ~4s, not the whole session) is
  WAV-encoded, base64'd, and sent as one transcription chat-completion, whose SSE response streams
  into `onPartialTranscript` as it arrives (throttled), stitched against text already committed
  from earlier windows. These requests are serialized - if the previous partial request is still in
  flight when the next mark is hit, that tick is skipped rather than firing a second overlapping
  request.
- `endSession` waits for any in-flight partial to finish. For a **short session** (one that never
  needed more than one window), it reuses that in-flight tick's result directly instead of paying
  for a second, fully redundant full-buffer request. For a **longer session**, it instead pays for
  exactly one final full-buffer transcription, streamed the same way - deliberately choosing
  accuracy over the (now seam-artifact-prone) stitched partial text, but only once.
- `cleanup` sends a system prompt instructing the model to strip filler words
  (um/uh/like/you know), collapse self-corrections/repeated false starts, and fix
  punctuation/capitalization while preserving meaning - plus a custom-vocabulary hint built from
  `settings.customVocabulary`. Output is expected to be the cleaned text only.
- `transform` sends a mode-specific prompt (Key Points / Formal / Short / Long).
- `voiceEdit` sends the text + the spoken/typed command and expects only the edited text back.
- All four strip a defensive `stripModelPreamble()` pass over the response - it removes
  `<think>...</think>` blocks, unwraps a single wrapping markdown code fence, drops a leading
  "Here is the cleaned text:"-style preamble line, and strips wrapping quotes, in case the model
  doesn't perfectly follow the "output only the text" instruction.

### Robustness

- Every sidecar request has a timeout (default 30s) via `AbortController`.
- SSE/JSON parsing never throws on malformed input - malformed chunks are skipped, not fatal.
- If the sidecar dies mid-session, the Promise-returning methods reject with a message;
  `pushAudio`'s periodic partial-transcription requests have no Promise to reject, so
  `LitertBackend` additionally implements an `onError` hook (`BackendErrorSource` in
  `src/shared/backend.ts`) that `backendIpc.ts` forwards to the renderer as a
  `backend:session-error` event.
- `Sidecar` (`src/main/backend/sidecar.ts`) auto-restarts a managed process up to 3 times with
  exponential backoff before giving up and reporting a fatal error; the header status pill
  reflects `starting` / `ready` / `error` throughout.
- `portGuard.ts` refuses to spawn a managed sidecar on a port a foreign, unidentified process
  already occupies, naming the PID in the error rather than silently trusting whatever answers
  that port. A pid-file lets it recognize and reclaim a stale sidecar of its own left over from a
  previous run that didn't shut down cleanly.

### GPU/CPU: observed, not requested

There is no accelerator setting - the managed sidecar always runs `resources/serve_gpu.py`, which
puts the model on the GPU when the machine has a usable one and drops to CPU by itself when it
doesn't (see `Accelerator` in `src/shared/types.ts` and `serve_gpu.py`'s own doc comment for the
full mechanism). `sidecar.ts` parses an `BLURT_EFFECTIVE_BACKEND=gpu`/`=cpu` marker line the
wrapper prints once it knows which backend it actually got, and that's the only thing Settings and
the status pill ever display (`BackendStatus.effectiveAccelerator`) - never the requested
accelerator, since that could be wrong. If a GPU-forced sidecar dies before ever becoming ready,
`Sidecar.start()` retries exactly once with `LITERT_LM_SERVE_BACKEND=cpu` forced in its environment
rather than leaving the app permanently broken on a machine with a broken GPU stack. See
[WINDOWS.md](WINDOWS.md) for the full GPU deep-dive, including measured throughput on a real GPU
and how the wrapper forces the backend in the first place.

### Settings that control it

All under `Settings.sidecar` (`src/shared/types.ts`), editable from the Settings screen's
Advanced section:

| Setting | Meaning |
| --- | --- |
| `modelId` | `'gemma-4-e2b' \| 'gemma-4-e4b' \| 'gemma-4-12b'` - which model `ModelManager` downloads/uses. |
| `sidecar.mode` | `'managed'` (app spawns the process) or `'external'` (you already have one running). |
| `sidecar.managedCommand` | Command template for managed mode. Default runs `resources/serve_gpu.py` through the resolved runtime venv's Python (`{venvPython}`/`{wrapperPath}` placeholders - see `venvResolver.ts`); `{port}` is substituted, then the whole thing is split into argv (quote-aware) and spawned directly (no shell). Only worth changing for a non-default `litert-lm` location or extra flags. |
| `sidecar.externalUrl` | Base URL for external mode, e.g. `http://127.0.0.1:9379` (litert-lm's real default port). |
| `sidecar.port` | Port used to build the local URL in managed mode, and substituted into `managedCommand`. |

### Model downloads

`ModelManager` (`src/main/backend/modelManager.ts`) downloads from the **ungated**
`litert-community/*` HuggingFace mirrors (Apache-2.0, no HF account/token needed):

| Model       | HF repo                                     | Sidecar alias | ~Size    |
| ----------- | ------------------------------------------- | ------------- | -------- |
| Gemma 4 E2B | `litert-community/gemma-4-E2B-it-litert-lm` | `e2b`         | ~2.4 GiB |
| Gemma 4 E4B | `litert-community/gemma-4-E4B-it-litert-lm` | `e4b`         | ~3.4 GiB |
| Gemma 4 12B | `litert-community/gemma-4-12B-it-litert-lm` | `12b`         | ~6.1 GiB |

The actual `.litertlm` filename inside each repo is **resolved at download time** via
`https://huggingface.co/api/models/<repo>` rather than hardcoded, then downloaded from that repo's
`resolve/main/<filename>` URL and stored locally as `<userData>/models/<modelId>.litertlm` - so "is
this installed" is a plain file-exists check, not a separate manifest. Downloads stream to a
`.part` file and `rename()` into place only on success; if a `.part` file already exists, the next
download attempt resumes via an HTTP `Range` request (falling back to a clean restart if the server
doesn't honor it). Progress (bytes received/total, state) is pushed to the Settings screen over IPC
as it downloads, including a final `'importing'` state (before `'done'`): once the file lands,
`ModelManager` shells out to the real `litert-lm import <file> <alias>` CLI, pointed at
`LITERT_LM_DIR=<userData>/litert-lm-home` - a sandbox entirely separate from your real
`~/.litert-lm` - so the model is immediately servable by alias without a separate manual step.

## Push-to-talk overlay (system-wide hold-to-talk)

Hold a key anywhere (not just while Blurt's window is focused) to start dictating into a small
floating pill, release to stop.

**Flow:** hold key down -> pill appears bottom-center of the primary display -> a short tone plays
once the microphone is genuinely capturing audio (device open can take ~1-2s) -> live transcript
streams in -> release key -> pill shows "Cleaning up..." -> cleanup pass runs -> cleaned text is
always copied to the clipboard, then (if enabled) pasted into whichever app currently has OS focus
via a simulated Ctrl+V immediately on cleanup completion -> pill briefly shows an inline word-diff
of raw vs. cleaned text (~1.5s) -> settles to the final text + "Copied" / "Pasted" -> fades out
after ~2.5s total, and the dictation is saved to History exactly like one from the Dictate tab. The
clipboard/paste step is never delayed by the diff-reveal - only the pill's visual state is. A hold
shorter than 250ms is treated as an accidental tap and silently discarded - this also absorbs OS
key-repeat, which sends many keydown events for one physical press.

**Architecture:**

```
uiohook-napi (global keydown/keyup, main process only)
        |
        v
PushToTalkController (src/main/pushToTalk/pushToTalkController.ts)
  - collapses key-repeat into one hold-start per physical press
  - <250ms hold -> 'accidental-tap'; otherwise -> 'hold-start' / 'hold-end'
  - entirely optional: if uiohook-napi fails to load, `getAvailability().available` is false and
    the controller is a permanent no-op
        |
        v
OverlayController (src/main/overlayController.ts)
  - shows/positions the overlay window (src/main/overlay.ts) on hold-start
  - sends 'overlay:ptt-start' / 'overlay:ptt-stop' / 'overlay:ptt-cancel' IPC to it
  - on the overlay renderer's 'overlay:result' (cleaned text), calls paste.ts, records history,
    then sends back 'overlay:paste-status' and schedules the ~2.5s auto-hide ('overlay:reset')
        |
        v
Overlay window's own renderer (src/renderer/src/overlay/*, loaded via a `#overlay` hash route on
the exact same renderer bundle the main window uses - no separate build target)
  - useOverlayPushToTalk.ts calls window.api.dictation.startSession/pushAudio/endSession/cleanup -
    the *same* IPC surface (src/main/ipc/backendIpc.ts) the main Dictate screen uses, so there is
    exactly one place that talks to the active InferenceBackend
  - reuses useAudioCapture (src/renderer/src/hooks/useAudioCapture.ts) unmodified for mic capture
    and live level metering - getUserMedia doesn't require window focus, and no
    setPermissionRequestHandler is registered anywhere in main/index.ts, so there's nothing
    blocking a non-focused window's webContents from requesting the microphone either
```

The overlay `BrowserWindow` (`src/main/overlay.ts`) is frameless, transparent, `skipTaskbar`,
`alwaysOnTop` at the `'screen-saver'` level, `resizable: false`, and critically **`focusable:
false`, shown only via `showInactive()`** - this is what makes the simulated Ctrl+V land in the app
the user was actually dictating into instead of the pill itself.

**Paste injection** (`src/main/paste.ts`) is platform-specific and always copies to the clipboard
first regardless of whether injection succeeds:

| Platform | Mechanism |
| -------- | --------- |
| Windows  | Spawns `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"` |
| macOS    | `osascript -e 'tell application "System Events" to keystroke "v" using command down'` |
| Linux    | `xdotool key --clearmodifiers ctrl+v`, only if `xdotool` is found on `PATH` (probed once, cached) |

Because the user is still physically releasing the push-to-talk key when this runs, a naive paste
could be received as e.g. Ctrl+Alt+V if that key were still logically "down" - mitigated with a
150ms settle delay after the real uiohook keyup event before injecting anything, plus
`--clearmodifiers` on the `xdotool` path. If injection is unavailable or fails for any reason, the
app falls back to clipboard-only and the pill shows "Copied - press Ctrl+V to paste" instead of
"Pasted".

### Known limitations

- **The native key hook (`uiohook-napi`) may not load at all on some machines.** It ships prebuilt
  N-API binaries, but its `linux-x64` prebuild requires glibc >= 2.34; on an older glibc,
  `require('uiohook-napi')` throws. The app handles this the same way it handles a missing/failed
  LiteRT-LM sidecar: push-to-talk is entirely optional, `PushToTalkController.getAvailability()` is
  checked before ever starting the OS hook, and Settings surfaces the exact error instead of the
  feature just doing nothing.
- **Under WSL/WSLg specifically, this feature cannot be truly system-wide.** `uiohook-napi`'s Linux
  backend hooks X11's RECORD extension - it only observes keys while an X11/WSLg-hosted window has
  input focus. Keystrokes typed into native Windows applications are invisible to it, and
  `xdotool`'s paste injection can only target X11 windows either. True system-wide push-to-talk
  into arbitrary native Windows applications requires running the app natively on Windows (see
  [WINDOWS.md](WINDOWS.md)), where `uiohook-napi`'s Win32 backend and the SendKeys-based paste
  injection are both genuinely global. Settings shows a hint explaining this whenever `/proc/version`
  indicates WSL (`src/main/wsl.ts`).
- Right Alt (the default key) is the "AltGr" key on many non-US keyboard layouts, used to type
  accented/special characters - Settings notes this next to the Right Alt option so affected users
  know to pick Right Ctrl or F9 instead (or just disable the feature).

## Local storage

Under Electron's `app.getPath('userData')`:

- `history.json` - array of `DictationEntry` (raw transcript, cleaned text, current display text,
  which transform (if any) produced it, word count, duration, WPM, timestamp)
- `settings.json` - the `Settings` object (model id, sidecar config, auto-copy, custom vocabulary,
  hotkey accelerator, push-to-talk enable/key/auto-paste)
- `models/<modelId>.litertlm` - downloaded model files; `models/<modelId>.litertlm.part` for an
  in-progress or interrupted download
- `logs/main.log` - rotating main-process log (Settings has an "Open logs folder" button)

## Building a distributable

```sh
npm run build
npm run build:win    # NSIS installer + portable exe, per electron-builder.yml
```

Must be run on a real Windows machine (or a Windows CI runner) - electron-builder needs the Windows
toolchain to produce these. `electron-builder install-app-deps` may fail to rebuild `uiohook-napi`
(the push-to-talk key hook) unless Visual Studio Build Tools are installed; that failure is safe to
ignore, because the package ships a prebuilt N-API binary that loads correctly at runtime. Neither
the installer nor the portable exe are code-signed - `build:win` explicitly disables
`CSC_IDENTITY_AUTO_DISCOVERY` - so a fresh install triggers a Windows SmartScreen warning; see
README's Troubleshooting section for what a user should click through.

`litert-lm` itself is **not bundled** by electron-builder - it's a separate Python package the app
installs into its own venv on first launch (see `src/main/runtime/firstRunSetup.ts`), exactly as
described in [WINDOWS.md](WINDOWS.md).

This has been run on a real Windows host and the resulting installer and portable exe were both
verified end to end: boot to a ready backend on GPU, a second launch refused by the single-instance
lock (`app.requestSingleInstanceLock()`), and a clean shutdown with no orphaned sidecar process.

## Known deviations / notes

- The AudioWorklet capture path requests a 16kHz `AudioContext`; some browsers/OS audio stacks
  ignore the requested sample rate and use the device default instead - `LitertBackend` doesn't
  assume exactly 16kHz, it tags the WAV it builds (`pcm16ToWavBase64` in `litertWire.ts`) with
  whatever sample rate `startSession`/the audio pipeline actually reported.
- `voiceEdit` has no dedicated screen mock-up in the original spec - it's exposed as a small
  text-command input on the Dictate screen so the full `InferenceBackend` contract is actually
  exercised by the UI, not just implemented.
- `BackendController`'s hot-swap doesn't cancel an in-flight `startSession`/`cleanup`/etc. call
  against the _old_ backend when settings change mid-call - it only stops accepting new work on the
  old instance and stops the old sidecar process once the new one is ready. A dictation session
  started just before a backend switch should still be allowed to finish naturally.
- Auto-update is not implemented. New versions have to be downloaded and installed manually.
