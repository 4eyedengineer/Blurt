# Windows Eloquent

A Windows-targeted desktop clone of Google AI Edge Eloquent - an offline-first AI dictation app.
Record speech, get a live streaming transcript, an automatic cleanup pass, and one-tap transforms
(Key Points / Formal / Short / Long), all backed by an on-device model.

The app is fully wired end-to-end - UI, IPC, audio capture, local history, settings, global
hotkey - and its single `InferenceBackend` implementation is:

- **LiteRT-LM** - a real on-device Gemma model, run via Google's `litert-lm` runtime as a local
  HTTP sidecar process. Requires downloading a `.litertlm` model (Settings does this for you) and
  either a `litert-lm` binary the app can spawn, or a `litert-lm serve` instance you already have
  running. See [The real backend: LiteRT-LM](#the-real-backend-litert-lm) below.

  (An earlier version of this app also shipped a **Mock** backend - canned demo transcripts and
  rule-based text ops, no download/model required - as a way to demo the UI without any setup. It
  was removed: it didn't do anything a real user of this app needed, since the point is dictating
  against a real model. If you want to poke at the UI without a GPU/model, the fastest real path
  is still the Gemma 4 E2B download - see Quick start below.)

## Quick start

**Just want to run the app, not develop it?** Grab the standalone installer/portable exe instead of
cloning this repo - see [WINDOWS.md's "Standalone app"](WINDOWS.md#standalone-app-no-scripts)
section. No scripts, no PowerShell, no manual Python setup - it bootstraps its own Python venv on
first launch if needed.

Everything below is the **developer** path - one-click launchers that bootstrap everything (Node
deps, a `litert-lm` Python venv, the Gemma E2B model) and then start the app in dev mode, safe to
re-run any time:

- **WSL / Linux**: `./run.sh`
- **Windows**: double-click `run-windows.bat` (it just runs `Start-Eloquent.ps1` with
  `-ExecutionPolicy Bypass` so it works even with script execution locked down). If your checkout
  lives on a UNC/WSL path (e.g. opened via `\\wsl.localhost\...` in Explorer - the common case when
  developing inside WSL), it first mirrors the source to a Windows-local working copy under
  `%LOCALAPPDATA%\WindowsEloquent\app` with `robocopy /MIR` and bootstraps there instead - source of
  truth stays in WSL, and re-running the launcher re-syncs your changes. See
  [WINDOWS.md](WINDOWS.md#quick-start-one-click-launcher) for details, and the alternative of
  cloning the repo natively onto a Windows drive instead.

Use the Windows one for actual dictation (real microphone, native GPU path) - see
[WINDOWS.md](WINDOWS.md). The WSL one is verified to bring up the real UI and the real LiteRT-LM
backend end-to-end (see [Running under WSLg](#running-under-wslg) below), but its microphone story
is unconfirmed. The Windows launcher's path handling (UNC detection, the local mirror, bootstrapping
in place on a local drive) was exercised from WSL via `cmd.exe`/`powershell.exe` interop against a
real Windows host; a literal Explorer double-click, a `winget` install, and a full model
download + `npm run dev` launch were not (see WINDOWS.md's "Quick start" section for exactly what
was and wasn't verified); please report back anything that doesn't match.

To wipe everything a launcher set up (venv, downloaded model, app settings/history/logs) and test
a fresh install: `./uninstall.sh` (WSL/Linux, add `--all` to also remove `node_modules`) or
double-click `uninstall-windows.bat` (Windows).

## Stack

- **Electron** (main/preload/renderer split, context isolation on, `nodeIntegration: false`)
- **React 19 + TypeScript** for the renderer
- **Vite** via **electron-vite** for building/dev-serving all three processes
- Plain CSS (no UI framework) - a small dark, Material-inspired design system in
  `src/renderer/src/assets`
- **electron-builder** configured for a Windows NSIS installer + portable exe (config only; not
  run in this environment)
- **uiohook-napi** for the optional system-wide push-to-talk key hook (main process only) - see
  [Push-to-talk overlay](#push-to-talk-overlay-system-wide-hold-to-talk) below

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
                               wordDiff.ts (pure LCS word-diff - see below)
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
model/sidecar settings change - see [The real backend: LiteRT-LM](#the-real-backend-litert-lm)
below. If it fails to start (bad sidecar command, model not downloaded, sidecar crashed past its
restart budget, ...), `BackendController` swaps in `UnavailableBackend` (defined alongside it) -
every method rejects with a clear message rather than silently degrading to fake output, so the
status pill and any in-flight call both surface the failure honestly.

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
  re-transcription to finish and emitting once. Unlike the original design, a partial tick does
  **not** re-transcribe the entire accumulated buffer - that made per-tick cost grow linearly with
  session length and fall behind the 1.5s cadence after only ~4s of speech on CPU (see
  `scratchpad/perf-review.md` §1). Instead, each tick only sends a bounded trailing **window**
  (`DEFAULT_PARTIAL_WINDOW_MS`, ~4s) of audio, overlapping the previous window by
  `DEFAULT_PARTIAL_WINDOW_OVERLAP_MS` (~0.8s) so a word cut off at the boundary gets a full second
  chance to be heard whole. `src/main/backend/transcriptStitcher.ts`'s `stitchTranscript` (pure,
  unit-tested) then finds the repeated words at that overlap and dedupes them, so the _displayed_
  text is always the full transcript-so-far - text from earlier windows is "committed" (fixed) once
  a later window's start advances past it, exactly like streaming-ASR "confirm on agreement"
  designs. This keeps every tick's request cost roughly flat regardless of how long the dictation
  has been running (empirically verified against a live sidecar - see "Rolling window verification"
  below) at the cost of occasional live-only seam artifacts, which `endSession`'s final pass (below)
  is unaffected by. A **spiral guard** (`src/main/backend/partialTickScheduler.ts`'s
  `shouldLaunchPartialTick`, pure + unit-tested with an injectable clock) also enforces a minimum
  real-world idle gap (`DEFAULT_MIN_PARTIAL_IDLE_GAP_MS`, 300ms) between a tick completing and the
  next one launching - without it, a backlog of "new audio arrived while the last tick was still
  running" would launch the next tick with zero breathing room the instant the previous one
  finished, pegging the CPU with back-to-back requests on slow hardware. Emits are throttled to
  ~100ms batches (`streamThrottleMs`) so a fast token stream doesn't spam IPC. `endSession`'s final
  pass streams the same way, over the same `onPartialTranscript`/`'partial'` event - no separate
  channel needed since the session is already marked ended by the time it fires.
  `cleanup`/`transform`/`voiceEdit` stream too, but via a separate, more generic mechanism: the
  caller mints an `operationId` (any string; the renderer uses `crypto.randomUUID()`), passes it as
  each method's optional last argument, and subscribes to `onTextStreamProgress`/the
  `backend:text-stream-progress` IPC event, filtering on that id. `useDictationSession`
  (`src/renderer/src/hooks/useDictationSession.ts`) uses this to show a live-growing preview while
  cleanup/transform are in flight, with a blinking caret (`.stream-caret` in `DictateScreen.css`)
  and a subtle shimmer before the first chunk arrives.
- **Inline-edit reveal on cleanup.** Rather than swapping straight from the raw transcript to the
  cleaned text, `useDictationSession.stopRecording` computes a word-level diff
  (`src/renderer/src/lib/wordDiff.ts`, `diffWords(rawTranscript, cleanedText)`) and shows it inline
  via `<DiffReveal>` (`src/renderer/src/components/DiffReveal.tsx`) for ~2s: removed words
  (fillers, false starts) strike through and fade to transparent, inserted/changed words highlight
  and fade, then it settles to the plain cleaned text. `applyVoiceEdit` gets a shorter (~1.2s)
  version of the same treatment. Critically, this delay is **purely visual** - `displayText`,
  history persistence, and auto-copy-on-cleanup all happen immediately once cleanup resolves; only
  the on-screen reveal lingers. `wordDiff.ts` is a pure LCS-based diff over whitespace-tokenized
  words: matching is case-insensitive with punctuation stripped (so a word that only gained/lost
  punctuation, or changed case, aligns as the same word - see `diffWords`'s doc comment for exactly
  how `'equal'` vs `'replace'` vs `'delete'`+`'insert'` are chosen), and it's unit-tested in
  `wordDiff.test.ts` (pure deletions, insertions, replacements, identical text, empty inputs). The
  push-to-talk overlay gets a lighter version of the same idea: `overlayState.ts` gained a
  `'revealing'` phase between `'cleaning'` and `'done'` that shows the diff inline in the pill for
  ~1.5s (`useOverlayPushToTalk.ts`'s `REVEAL_SETTLE_MS`) - again, the clipboard copy/paste fires
  immediately on cleanup completion (`window.api.overlay.sendResult`), never delayed by the reveal.

## The real backend: LiteRT-LM

`LitertBackend` (`src/main/backend/litertBackend.ts`) implements `InferenceBackend` by talking to
[Google's LiteRT-LM runtime](https://github.com/google-ai-edge/LiteRT-LM), run out-of-process as
`litert-lm serve` - an OpenAI-compatible HTTP/SSE server. This is Option A from the
runtime's own de-risking notes: `litert-lm serve` already _is_ the "wrapper exposing HTTP" this
app needs, so the app just spawns/talks to it rather than re-implementing an FFI binding.

### Architecture

```
Settings (modelId, sidecar.*)
        │
        ▼
BackendController (src/main/backend/backendController.ts)
  - reads settings, builds/rebuilds LitertBackend (or UnavailableBackend on failure)
  - owns the current Sidecar + LitertBackend, hot-swaps on settings changes
  - exposes getStatus()/'status' events -> header status pill
        │
        ▼
Sidecar (src/main/backend/sidecar.ts)          ModelManager (src/main/backend/modelManager.ts)
  - 'managed': spawns `litert-lm serve ...`      - resolves + downloads .litertlm files from
    from a configurable command template           HuggingFace, tracks progress, lists installed
  - 'external': just points at a URL you gave it   models
  - polls GET /v1/models until ready, restarts
    a managed process with backoff on crash
        │
        ▼
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
touches JSON/SSE shapes directly. If a real server turns out to disagree with an assumption here
(e.g. a different content-part key for audio, or a non-standard SSE chunk shape), only this one
file needs to change; `src/main/backend/litertWire.test.ts` covers it with unit tests you can run
with `npm test`.

### What it assumes about the sidecar

Verified against a real `litert-lm` 0.14.0 pip install and a real gemma-4-E2B model (see
`scratchpad/sidecar-verification.md` for the full raw captures, and
`scripts/integration-live.mjs` for a repeatable live check against a running server):

- `POST /v1/chat/completions`, OpenAI-compatible, `stream: true` giving SSE
  (`text/event-stream`) `chat.completion.chunk`-shaped events, terminated by a `data: [DONE]`
  event. If the sidecar instead returns a normal JSON body (non-SSE), `litertBackend.ts` falls
  back to parsing that directly (see `extractContentFromChatCompletionResponse`). **Confirmed
  exact match**, including streaming - no adjustments needed.
- Audio is sent as a user-message content part:
  `{ type: 'input_audio', input_audio: { data: '<base64 wav>', format: 'wav' } }`, alongside a
  `{ type: 'text', text: '<transcription prompt>' }` part. **Confirmed**, with two gotchas: the
  `format` field is read but never validated - the engine just requires `data` to decode to a real
  RIFF/WAV container (any declared sample rate works; no client-side resampling needed), and
  **headerless raw PCM16 silently returns `content: null`** (HTTP 200, no error) rather than
  failing loudly - `pcm16ToWavBuffer` always emits a proper WAV header for exactly this reason.
- `GET /v1/models` is used purely as a "is the server up yet" health check - **confirmed**, but
  note it responds 200 within ~1-2s of process start well before the model is actually loaded into
  memory (loading is lazy, on the first real inference request - see `buildWarmupRequest` below).
- No `usage`/token-count field appears in any response, streamed or not - if the app ever wants to
  show/log token counts, they'd need to be estimated client-side.
- The reference server (`http.server.HTTPServer`, not `ThreadingHTTPServer`) is single-threaded -
  a second concurrent request just blocks on the TCP accept until the first fully completes.
  `LitertBackend` funnels every outgoing request through one serial promise-chain queue for this
  reason (see the `enqueue`/`requestQueue` private members in `litertBackend.ts`) rather than
  assuming the sidecar can service overlapping calls.
- Model selection is per-request via the JSON body's `"model"` field, but that field must be the
  **alias** the model was registered under via `litert-lm import <file> <alias>` (see
  `ModelCatalogEntry.alias` in `src/shared/models.ts`) - not this app's own `ModelId` (e.g.
  `"gemma-4-e2b"`). `serve` itself takes no model-selection flag at all; `BackendController`
  resolves the alias and imports the model (via `ModelManager.importModel`) before starting the
  sidecar if it hasn't been already.
- `buildWarmupRequest` (`litertWire.ts`) builds a minimal throwaway completion used to force the
  lazy model load to happen right after the sidecar comes up (`LitertBackend.warmup()`, fired by
  `BackendController` once the sidecar is ready) instead of on the user's first real utterance -
  empirically, a cold first request pays ~5.6s extra vs. ~1.4s once warm (E2B/CPU). The warmup
  request includes a tiny (~0.3s) silent `input_audio` part alongside its text part, not just text -
  the audio submodel appears to load lazily and separately from the text backbone (per the
  HuggingFace model-card note), so a text-only warmup left it cold for the user's first real
  dictation. Empirically (3 cold-restart trials each, live sidecar, E2B/CPU): a from-cold first audio
  request with no warmup at all took ~1716-2272ms; after a **text-only** warmup it dropped to
  ~1122-1541ms (avg ~1316ms, noticeably variable run to run); after a **text+audio** warmup it landed
  at a tight, consistent ~1063-1065ms every time. The audio warmup's win is less about the average
  (~250ms faster than text-only) and more about eliminating the variance/tail latency - text-only
  warmup's first audio request was still doing _some_ unpredictable extra work text+audio warmup
  reliably avoids.

### Session lifecycle mapping

- `startSession` allocates an in-memory buffer for the session's PCM16 audio (no request to the
  sidecar yet), plus a small rolling "recent audio" buffer used for partial ticks (see below).
- `pushAudio` appends to both buffers. Once ~1.5 seconds of _new_ audio has accumulated (and the
  spiral-guard idle gap has elapsed since the last tick completed - see "Streaming partials" above),
  a partial tick fires: only a bounded trailing **window** of audio (`DEFAULT_PARTIAL_WINDOW_MS`,
  ~4s, not the whole session) is WAV-encoded, base64'd, and sent as one transcription
  chat-completion, whose SSE response streams into `onPartialTranscript` as it arrives (throttled),
  stitched (`transcriptStitcher.ts`) against text already committed from earlier windows so the
  displayed text is always the full transcript-so-far. These requests are serialized - if the
  previous partial request is still in flight when the next mark is hit, that tick is skipped rather
  than firing a second overlapping request.
- `endSession` waits for any in-flight partial to finish. For a **short session** (one that never
  needed more than one window - the common case, e.g. a quick test utterance), it reuses that
  in-flight tick's result directly instead of paying for a second, fully redundant full-buffer
  request (see `litertBackend.ts`'s `endSession` doc comment for the regression this fixes). For a
  **longer session** (audio has exceeded one window's worth), it instead pays for exactly one final
  full-buffer transcription, streamed the same way over `onPartialTranscript` - deliberately
  choosing accuracy over the (now seam-artifact-prone) stitched partial text, but only once, not on
  top of the rolling-window ticks' own (now bounded) cost.
- `cleanup` sends a system prompt instructing the model to strip filler words
  (um/uh/like/you know), collapse self-corrections/repeated false starts, and fix
  punctuation/capitalization while preserving meaning - plus a custom-vocabulary hint
  ("the user commonly uses these terms, spell them correctly: ...") built from
  `settings.customVocabulary`. Output is expected to be the cleaned text only.
- `transform` sends a mode-specific prompt (Key Points / Formal / Short / Long).
- `voiceEdit` sends the text + the spoken/typed command and expects only the edited text back.
- All four strip a defensive `stripModelPreamble()` pass over the response - it removes
  `<think>...</think>` blocks, unwraps a single wrapping markdown code fence, drops a leading
  "Here is the cleaned text:"-style preamble line, and strips wrapping quotes - in case the model
  doesn't perfectly follow the "output only the text" instruction.

### Robustness

- Every sidecar request has a timeout (default 30s) via `AbortController`.
- SSE/JSON parsing never throws on malformed input - malformed chunks are skipped, not fatal.
- If the sidecar dies mid-session (crash, or `endSession`/`cleanup`/etc. can't reach it), the
  Promise-returning methods reject with a message; `pushAudio`'s periodic partial-transcription
  requests have no Promise to reject, so `LitertBackend` additionally implements an `onError`
  hook (`BackendErrorSource` in `src/shared/backend.ts`) that `backendIpc.ts` forwards to the
  renderer as a `backend:session-error` event (surfaced next to the audio-capture warning on the
  Dictate screen).
- `Sidecar` (`src/main/backend/sidecar.ts`) auto-restarts a managed process up to 3 times with
  exponential backoff before giving up and reporting a fatal error; the header status pill
  reflects `starting` / `ready` / `error` throughout.

### Settings that control it

All under `Settings.sidecar` (`src/shared/types.ts`), editable from the Settings screen's
"Model"/"Sidecar" groups:

| Setting                  | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modelId`                | `'gemma-4-e2b' \| 'gemma-4-e4b' \| 'gemma-4-12b'` - which model `ModelManager` downloads/uses.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `sidecar.mode`           | `'managed'` (app spawns the process) or `'external'` (you already have one running).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `sidecar.managedCommand` | Command template for managed mode. Default: `litert-lm serve --host 127.0.0.1 --port {port}` - `{port}` is substituted, then split into argv (quote-aware) and spawned directly (no shell). `{modelPath}` is also substituted if present, for custom wrapper scripts, but the real `litert-lm serve` CLI takes no model-selection flag at all (verified - see "What it assumes about the sidecar" above); this is a setting rather than a hardcoded invocation mainly so a non-default `litert-lm` install location or extra flags (e.g. `--cors-origin`) can be configured without a code change. |
| `sidecar.externalUrl`    | Base URL for external mode, e.g. `http://127.0.0.1:9379` (litert-lm's real default port).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sidecar.port`           | Port used to build the local URL in managed mode, and substituted into `managedCommand`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

### Model downloads

`ModelManager` (`src/main/backend/modelManager.ts`) downloads from the **ungated**
`litert-community/*` HuggingFace mirrors (Apache-2.0, no HF account/token needed):

| Model       | HF repo                                     | Sidecar alias | ~Size    |
| ----------- | ------------------------------------------- | ------------- | -------- |
| Gemma 4 E2B | `litert-community/gemma-4-E2B-it-litert-lm` | `e2b`         | ~2.4 GiB |
| Gemma 4 E4B | `litert-community/gemma-4-E4B-it-litert-lm` | `e4b`         | ~3.4 GiB |
| Gemma 4 12B | `litert-community/gemma-4-12B-it-litert-lm` | `12b`         | ~6.1 GiB |

The actual `.litertlm` filename inside each repo is **resolved at download time** via
`https://huggingface.co/api/models/<repo>` rather than hardcoded (repo maintainers can rename
files across releases), then downloaded from that repo's `resolve/main/<filename>` URL and stored
locally as `<userData>/models/<modelId>.litertlm` - so "is this installed" is a plain file-exists
check, not a separate manifest. Downloads stream to a `.part` file and `rename()` into place only
on success; if a `.part` file already exists, the next download attempt resumes via an HTTP
`Range` request (falling back to a clean restart if the server doesn't honor it). Progress
(bytes received/total, state) is pushed to the Settings screen over IPC as it downloads, including
a final `'importing'` state (before `'done'`): once the file lands, `ModelManager` shells out to
the real `litert-lm import <file> <alias>` CLI (using the alias from the table above), pointed at
`LITERT_LM_DIR=<userData>/litert-lm-home` - a sandbox entirely separate from your real
`~/.litert-lm` - so the model is immediately servable by alias without a separate manual step. See
`ModelManager`'s class doc comment in `modelManager.ts` for why this shells out to the real CLI
rather than reimplementing the (simple, but version-coupled) import logic itself.

### Building/installing `litert-lm` on Windows

**See [WINDOWS.md](WINDOWS.md) for the complete, step-by-step Windows setup guide** (Python/pip
install, model import, Settings configuration, dev run, `build:win`, and the full GPU acceleration
writeup - what it measured on a real RTX 3060 (one labeled example machine, not a requirement - GPU
acceleration goes through Dawn/WebGPU's D3D12 backend, which supports any DX12-capable GPU:
NVIDIA/AMD/Intel alike, see WINDOWS.md's "Supported hardware" for the vendor-agnostic spec and the
minimum-VRAM floor), and how `resources/serve_gpu.py` gets GPU execution out of a `serve` CLI that
has no `--backend` flag of its own - including its parent-watchdog, which shuts the sidecar (and
releases its GPU/CPU memory) down immediately if the Electron app is killed or crashes, not just on
a clean quit. The rest of this section is a quick summary.

This app doesn't bundle `litert-lm` - it's a separate install the user (or your installer/setup
script) provides, referenced by `sidecar.managedCommand`. A documented from-source Windows build
recipe exists upstream (see [google-ai-edge/LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM),
`docs/getting-started/build-and-run.md`): Visual Studio 2022 ("Desktop development with C++"),
Bazel via Bazelisk, Git for Windows (its bundled `bash.exe` is required - some build steps shell
out to it), Python 3.13, a JDK, and enabling NTFS long paths (`LongPathsEnabled` registry key,
since Bazel's output tree nests deep). CPU builds are `bazelisk build //runtime/engine:litert_lm_main --config=windows`;
GPU (WebGPU/Dawn/D3D12) builds additionally need
`--define=litert_runtime_link_mode=dynamic --define=resolve_symbols_in_exec=false` and require
copying the prebuilt accelerator DLLs (`prebuilt/windows_x86_64/*.dll`) plus Dawn's
`dxcompiler.dll`/`dxil.dll` (fetched hermetically by Bazel from Microsoft's
DirectXShaderCompiler releases) into the same directory as the built binary - a hand-built binary
doesn't get these copied automatically the way the upstream Python-wheel build target does.
Simpler alternative for most users: the `litert-lm` Python CLI (`pip install litert-lm` /
`uv tool install litert-lm`) ships a working `litert-lm serve` without a from-source build - point
`sidecar.managedCommand` at whichever one you have installed.

## Running under WSLg

Contrary to an earlier draft of this doc (see the last bullet of
[Known deviations / notes](#known-deviations--notes) for the original claim), this was later
re-checked on a WSL2 box that turned out to have **WSLg** (`DISPLAY`, `WAYLAND_DISPLAY`, and
`/tmp/.X11-unix` all present, plus a WSLg PulseAudio server at `/mnt/wslg/PulseServer`) - so the
Electron UI, and the real LiteRT-LM backend, were both actually run headed, not just verified at
the wire-protocol level. `./run.sh` automates everything below.

**What was confirmed, empirically, on that box:**

- The Electron window opens and renders normally under WSLg's X11 server - confirmed via
  `webContents.capturePage()` screenshots taken right after `ready-to-show` (temporary
  instrumentation, not shipped). One flag was required: `--noSandbox` (electron-vite's own flag,
  passed through as `npm run dev -- --noSandbox`) - `node_modules/electron/dist/chrome-sandbox`
  isn't setuid-root in a plain `npm install`, fixing that needs `sudo chown root:root
chrome-sandbox && sudo chmod 4755 chrome-sandbox`, and passwordless `sudo` isn't a safe thing to
  assume. `run.sh` detects this (checks the binary's owner/permission bits) and only adds
  `--noSandbox` when the setuid helper actually isn't usable, so a properly-configured Linux
  desktop keeps the real sandbox.
- The full real backend works end-to-end in this mode too: a persistent `litert-lm` venv
  (`./.runtime/venv`, gitignored, created by `run.sh`) puts a real `litert-lm` binary on `PATH`,
  the app's managed sidecar spawns `litert-lm serve` from it, imports the Gemma E2B model into its
  own sandboxed `LITERT_LM_DIR`, and the status pill reaches **"LiteRT-LM ready"** - captured on
  screen within ~5 seconds of window-show (the model file was pre-copied into the app's own
  `userData/models/` directory rather than re-downloaded, since it was already on disk from
  extending this integration; a first run for someone else pays the one-time ~2.4 GiB HuggingFace
  download `run.sh` does automatically).
- `dbus` connection errors in the log (`Failed to connect to the bus: ...`) are harmless noise from
  running without a system/session bus - they don't stop the window from opening or the backend
  from working.

**Microphone - the honest, unresolved part:** WSLg exposes a PulseAudio source named `RDPSource`
(`pactl list sources short`). It's `SUSPENDED` at idle (normal PulseAudio behavior) but transitions
to `RUNNING` and produces genuinely non-silent sample data when captured with `parecord` - so
WSLg's OS-level audio-bridge plumbing is real, not a stub. What this _doesn't_ prove: whether that
picks up an actual physical microphone on the Windows host (muted/absent input devices would still
pass the same `parecord` check with just noise-floor samples), and whether Chromium's
`getUserMedia()` inside Electron binds to it cleanly - that specific path wasn't separately
exercised here. Practically: treat WSL/WSLg as good enough for UI and backend development/demoing,
and use the Windows host ([WINDOWS.md](WINDOWS.md)) as the path for dictation you actually trust to
capture real speech.

GPU acceleration (see [WINDOWS.md](WINDOWS.md#6-gpu-acceleration---how-it-works-and-what-was-measured))
needs a real Vulkan-capable adapter, which this WSL2/WSLg box doesn't have - the `serve_gpu.py`
wrapper's own fallback logic catches that (verified: it logs `[serve_gpu] GPU engine
initialization failed (...)` and retries on CPU) rather than the backend simply not existing here.
GPU is still the default accelerator setting, but the app never claims it's actually running on GPU
when it isn't - this exact CPU-fallback case is also what proved out the truthful effective-backend
reporting (`ELOQUENT_EFFECTIVE_BACKEND=cpu` printed by the wrapper, surfaced as "CPU (GPU
unavailable)" in Settings and "Ready · CPU" in the status pill - see WINDOWS.md's GPU section). The
GPU path itself was verified on the actual Windows host - see WINDOWS.md for the real RTX 3060
tokens/s numbers.

## App features

1. **Dictate** - big record button; live streaming transcript while recording (tokens stream in as
   recognized, with a blinking caret - see "Streaming partials" above); automatic cleanup pass on
   stop, briefly showing an inline word-diff of what changed before settling to the cleaned text;
   Key Points / Formal / Short / Long transform buttons; copy-to-clipboard button; optional
   auto-copy-on-cleanup (Settings); a small "voice edit command" box that exercises `voiceEdit`
   (e.g. `replace foo with bar`, `delete the last sentence`), with its own brief diff-reveal.
2. **History** - every completed dictation is persisted as JSON in Electron's `userData` dir
   (`history.json`), searchable by text, deletable, and clickable to reopen (re-loads the raw,
   cleaned, and last-transformed text plus its original stats into the Dictate screen).
3. **Settings** - model choice (Gemma 4 E2B / E4B / 12B) with per-model download/install state and
   a progress bar, a read-only GPU/CPU readout of what the engine actually reported, sidecar
   mode/command/URL/port fields, custom vocabulary list (add/remove, persisted in `settings.json`), auto-copy
   toggle, and a global hotkey field that calls `globalShortcut.register` in the main process for
   real (default `Ctrl+Shift+Space`) - triggering it brings the window to front and toggles
   recording from anywhere in Windows.
4. **Session stats** - word count and words-per-minute, computed from the cleaned transcript and
   wall-clock recording duration, shown after every dictation.
5. **Backend status pill** - a small pill at the bottom of the sidebar showing the active
   backend's connectivity state (starting / ready / error, with the error message as a
   tooltip), fed by `useBackendStatus` (`src/renderer/src/hooks/useBackendStatus.ts`).
6. **Push-to-talk overlay** - hold a configurable key (default Right Alt) anywhere to pop up a
   small always-on-top toolbar and dictate; release to clean up, copy, and (optionally)
   auto-paste into whatever app had focus. See
   [Push-to-talk overlay](#push-to-talk-overlay-system-wide-hold-to-talk) below - **and its "Known
   limitations" subsection in particular** before relying on this under WSL.

## Push-to-talk overlay (system-wide hold-to-talk)

Modeled on the macOS Eloquent app's system-wide dictation flow: hold a key anywhere (not just
while this app's window is focused) to start dictating into a small floating pill, release to stop.

**Flow:** hold key down -> pill appears bottom-center of the primary display, live transcript
streams in -> release key -> pill shows "Cleaning up…" -> cleanup pass runs -> cleaned text is
always copied to the clipboard, then (if enabled) pasted into whichever app currently has OS focus
via a simulated Ctrl+V **immediately** on cleanup completion -> pill briefly shows an inline
word-diff of raw vs. cleaned text (~1.5s - see "Streaming partials + the cleanup diff-reveal"
above) -> settles to the final text + "Copied ✓" / "Pasted ✓" -> fades out after ~2.5s total. The
clipboard/paste step is never delayed by the diff-reveal - only the pill's visual state is. A hold
shorter than 250ms is treated as an accidental tap and silently discarded (no cleanup/copy/paste,
pill disappears almost immediately) - this also absorbs OS key-repeat, which sends many keydown
events for one physical press.

**Architecture:**

```
uiohook-napi (global keydown/keyup, main process only)
        │
        ▼
PushToTalkController (src/main/pushToTalk/pushToTalkController.ts)
  - collapses key-repeat into one hold-start per physical press
  - <250ms hold -> 'accidental-tap'; otherwise -> 'hold-start' / 'hold-end'
  - entirely optional: if uiohook-napi fails to load, `getAvailability().available` is false and
    the controller is a permanent no-op (see "Known limitations" below)
        │
        ▼
OverlayController (src/main/overlayController.ts)
  - shows/positions the overlay window (src/main/overlay.ts) on hold-start
  - sends 'overlay:ptt-start' / 'overlay:ptt-stop' / 'overlay:ptt-cancel' IPC to it
  - on the overlay renderer's 'overlay:result' (cleaned text), calls paste.ts, then sends back
    'overlay:paste-status' and schedules the ~2.5s auto-hide ('overlay:reset')
        │
        ▼
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
false`, shown only via `showInactive()`** - this is what makes the later simulated Ctrl+V land in
the app the user was actually dictating into instead of the pill itself.

**Paste injection** (`src/main/paste.ts`) is platform-specific and always copies to the clipboard
first regardless of whether injection succeeds:

| Platform | Mechanism                                                                                                                              |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Windows  | Spawns `powershell -NoProfile -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^v')"` |
| macOS    | `osascript -e 'tell application "System Events" to keystroke "v" using command down'`                                                  |
| Linux    | `xdotool key --clearmodifiers ctrl+v`, only if `xdotool` is found on `PATH` (probed once, cached)                                      |

Because the user is still physically releasing the push-to-talk key when this runs, a naive paste
could be received as e.g. Ctrl+Alt+V if that key were still logically "down" - mitigated with a
150ms settle delay after the real uiohook keyup event before injecting anything, plus
`--clearmodifiers` on the `xdotool` path. If injection is unavailable or fails for any reason, the
app falls back to clipboard-only and the pill shows "Copied — press Ctrl+V to paste" instead of
"Pasted ✓".

**Settings** ("Push to talk" section): enable/disable, key picker (Right Alt / Right Ctrl / F9 -
`PTT_KEY_OPTIONS` in `src/shared/types.ts`), and an auto-paste toggle (clipboard-only vs.
clipboard + simulated paste). If the native key hook failed to load, Settings explains why instead
of the feature silently doing nothing.

### Known limitations

- **The native key hook (`uiohook-napi`) may not load at all on some machines.** Verified
  empirically in this project's own dev container: it ships prebuilt N-API binaries (no
  `electron-rebuild` needed in principle), but the `linux-x64` prebuild requires glibc >= 2.34,
  and this container has glibc 2.31 - `require('uiohook-napi')` throws
  `ERR_DLOPEN_FAILED: ... GLIBC_2.34 not found`, reproduced identically under Electron's own
  bundled Node. The app handles this the same way it handles a missing/failed LiteRT-LM sidecar:
  push-to-talk is entirely optional, `PushToTalkController.getAvailability()` is checked before
  ever starting the OS hook, and Settings surfaces the exact error instead of the feature just
  doing nothing. Separately, `electron-builder install-app-deps` (this project's `postinstall`)
  always attempts a from-source rebuild of native deps regardless of `npmRebuild` in
  `electron-builder.yml` (that setting only affects the `build`/`pack` commands) - in this same
  container that rebuild fails too (`X11/extensions/record.h: No such file or directory` - the
  X11 dev headers aren't installed), so `postinstall` tolerates a failed rebuild
  (`|| echo ...`) rather than breaking `npm install` outright, since the rebuild isn't actually
  needed for N-API modules on a properly-matched host anyway.
- **Under WSL/WSLg specifically, this feature cannot be truly system-wide.** `uiohook-napi`'s
  Linux backend hooks X11's RECORD extension - it only observes keys while an X11/WSLg-hosted
  window has input focus. Keystrokes typed into native Windows applications (anything not running
  inside the WSL/WSLg X server) are invisible to it. Likewise, `xdotool`'s paste injection can only
  target X11 windows, so even if the key hook fired, there'd be nothing to paste into for a native
  Windows app. Practically: under WSL, push-to-talk only works while dictating into an
  X11/WSLg-hosted app (including this Electron app's own window); **true system-wide push-to-talk
  into arbitrary native Windows applications requires running the app natively on Windows** (see
  [WINDOWS.md](WINDOWS.md)), where `uiohook-napi`'s Win32 backend and the SendKeys-based paste
  injection are both genuinely global. Settings shows a muted hint explaining this whenever
  `/proc/version` indicates WSL (`src/main/wsl.ts`).
- Right Alt (the default key) is the "AltGr" key on many non-US keyboard layouts, used to type
  accented/special characters - Settings notes this next to the Right Alt option so affected users
  know to pick Right Ctrl or F9 instead (or just disable the feature).
- `xdotool` was not installed in this project's dev container, so the Linux paste-injection path
  itself (as opposed to the key hook) could not be exercised live here either - `checkXdotoolAvailable()`
  correctly reports it missing and the app falls back to clipboard-only, but this is worth a real
  test on a Linux box that has it installed.

## Local storage

Under Electron's `app.getPath('userData')` (on Windows, typically `%APPDATA%/windows-eloquent/`):

- `history.json` - array of `DictationEntry` (raw transcript, cleaned text, current display text,
  which transform (if any) produced it, word count, duration, WPM, timestamp)
- `settings.json` - the `Settings` object (model id, sidecar config, auto-copy, custom
  vocabulary, hotkey accelerator, push-to-talk enable/key/auto-paste)
- `models/<modelId>.litertlm` - downloaded model files (see [Model downloads](#model-downloads));
  `models/<modelId>.litertlm.part` for an in-progress or interrupted download

## Development

```sh
npm install
npm run dev          # electron-vite dev server + Electron, with HMR
npm run typecheck    # tsc --noEmit for both the node (main/preload) and web (renderer) tsconfigs
npm run lint          # eslint (flat config, includes prettier + react-hooks rules)
npm test               # vitest - unit tests for litertWire.ts (request/response/SSE parsing,
                       # WAV encoding), sidecar.ts's command templating, push-to-talk's key-map/
                       # debounce/controller/WSL-detection/paste-command logic, and the overlay's
                       # phase reducer - all pure or dependency-injected, no native module needed
npm run build         # typecheck, then electron-vite build (main + preload + renderer)
npm run build:win     # build, then electron-builder --win (NSIS + portable) - not run in CI/dev
                       # containers without Windows/Wine; config lives in electron-builder.yml
```

### Environment note: Rollup on old glibc

This scaffold was built in a container with glibc 2.31. Rollup 4's prebuilt native binary requires
glibc 2.32+, which fails to load with `ERR_DLOPEN_FAILED`. `package.json` pins an `overrides`
entry redirecting `rollup` to `@rollup/wasm-node` (a WASM build of the same version, no native
addon) so `npm install && npm run build` works in that kind of environment. On a normal
Windows/macOS/modern-Linux dev machine this override is harmless but unnecessary - feel free to
remove it if you don't hit that issue.

## Known deviations / notes

- The AudioWorklet capture path requests a 16kHz `AudioContext`; some browsers/OS audio stacks
  ignore the requested sample rate and use the device default instead - `LitertBackend` doesn't
  assume exactly 16kHz, it tags the WAV it builds (`pcm16ToWavBase64` in `litertWire.ts`) with
  whatever sample rate `startSession`/the audio pipeline actually reported.
- `voiceEdit` has no dedicated screen mock-up in the original spec - it's exposed here as a small
  text-command input on the Dictate screen so the full `InferenceBackend` contract is actually
  exercised by the UI, not just implemented.
- **Superseded note**: an earlier draft of this doc said "this environment has no display server,
  so the Electron UI itself was never exercised here." That was true of the box this app was
  originally scaffolded on, but not of every environment it's since been run in - see
  [Running under WSLg](#running-under-wslg) above for a headed run (real window, real backend
  reaching "ready", screenshots captured) on a WSLg-enabled WSL2 box. What's _still_ unexercised
  anywhere so far: real end-to-end dictation through an actually-confirmed physical microphone (see
  the WSLg section's honest caveat about `RDPSource`), and `npm run build:win` packaging (needs a
  real Windows/electron-builder toolchain - see the last bullet below). Independent of all that,
  the wire protocol itself **has** been verified live against a real server regardless of any UI:
  a real `litert-lm` 0.14.0 CLI was pip-installed into a venv, a real `gemma-4-E2B` model was
  imported and served, and `scripts/integration-live.mjs` (a plain-Node script that replicates
  `litertWire.ts`'s exact request builders/SSE parsing) was run against it end-to-end: health
  check, SSE streaming completion, WAV transcription (perfect verbatim output), filler-word
  cleanup, and a Key Points transform all passed against the real server - see
  `scratchpad/sidecar-verification.md` for the full raw captures this was based on. All
  wire-format assumptions remain isolated in `litertWire.ts` specifically so future drift only
  needs one file to change.
- `BackendController`'s hot-swap doesn't cancel an in-flight `startSession`/`cleanup`/etc. call
  against the _old_ backend when settings change mid-call - it only stops accepting new work on
  the old instance and stops the old sidecar process once the new one is ready. A dictation
  session started just before a backend switch should still be allowed to finish naturally.
- Auto-update is not implemented. New versions have to be downloaded and installed manually.
