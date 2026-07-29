# Windows Eloquent

A Windows-targeted desktop clone of Google AI Edge Eloquent - an offline-first AI dictation app.
Record speech, get a live streaming transcript, an automatic cleanup pass, and one-tap transforms
(Key Points / Formal / Short / Long), all backed by an on-device model.

The app is fully wired end-to-end - UI, IPC, audio capture, local history, settings, global
hotkey - and ships with two `InferenceBackend` implementations, switchable from Settings:

- **Mock** - replays canned demo transcripts and rule-based text ops. No download, no external
  process, works everywhere. Good for demoing the UI without any setup.
- **LiteRT-LM** - a real on-device Gemma model, run via Google's `litert-lm` runtime as a local
  HTTP sidecar process. Requires downloading a `.litertlm` model (Settings does this for you) and
  either a `litert-lm` binary the app can spawn, or a `litert-lm serve` instance you already have
  running. See [The real backend: LiteRT-LM](#the-real-backend-litert-lm) below.

## Quick start

One-click launchers that bootstrap everything (Node deps, a `litert-lm` Python venv, the Gemma E2B
model) and then start the app, safe to re-run any time:

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

## Stack

- **Electron** (main/preload/renderer split, context isolation on, `nodeIntegration: false`)
- **React 19 + TypeScript** for the renderer
- **Vite** via **electron-vite** for building/dev-serving all three processes
- Plain CSS (no UI framework) - a small dark, Material-inspired design system in
  `src/renderer/src/assets`
- **electron-builder** configured for a Windows NSIS installer + portable exe (config only; not
  run in this environment)

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
    backend/
      mockBackend.ts           MockBackend: canned-script InferenceBackend, no real model
      textOps.ts                cleanup / transform / voiceEdit text logic used by MockBackend
      scripts.ts                 Canned "recognized speech" used to fake streaming transcripts
      litertWire.ts             Pure request builders + SSE/JSON response parsers + WAV encoder
                                 for the LiteRT-LM sidecar's wire protocol - see below
      litertBackend.ts          InferenceBackend backed by a LiteRT-LM sidecar (HTTP/SSE)
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

  preload/                  contextBridge boundary
    index.ts                  Exposes a typed `window.api` (dictation / history / settings /
                               hotkey / models)
    index.d.ts                 Global Window typing for `window.api`

  renderer/                 The React app
    public/
      pcm-worklet-processor.js  AudioWorkletProcessor (plain JS, runs in its own global scope -
                                 see comments in the file for why it's not bundled)
    src/
      App.tsx                   Tab shell (Dictate / History / Settings)
      context/SettingsContext.tsx
      hooks/
        useAudioCapture.ts       Mic capture: AudioWorklet 16kHz PCM16, MediaRecorder/webm fallback
        useDictationSession.ts   Orchestrates record -> cleanup -> transform -> history lifecycle
        useBackendStatus.ts      Subscribes to the header status pill's backend state
        useModelManager.ts       Drives the Settings screen's model download UI
      screens/                 DictateScreen, HistoryScreen, SettingsScreen
      components/              RecordButton, TransformBar, StatsBar, VoiceEditBar, Sidebar,
                               StatusPill, Toggle, Icons
      lib/                     format.ts (word count / WPM / byte formatting), clipboard.ts
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
  cleanup(text: string): Promise<string>
  transform(text: string, mode: TransformMode): Promise<string>
  voiceEdit(text: string, command: string): Promise<string>
}
```

This interface only ever runs in the **main process**. The renderer never touches it directly -
it goes through the typed IPC bridge in `src/preload/index.ts` (`window.api.dictation.*`), which
is wired to the concrete backend instance in `src/main/ipc/backendIpc.ts`.

Two implementations exist today, and the active one is chosen per `settings.backend`
(`'mock' | 'litert'`), built and hot-swapped by `BackendController`
(`src/main/backend/backendController.ts`) - see
[The real backend: LiteRT-LM](#the-real-backend-litert-lm) below for the second one.

`MockBackend` (`src/main/backend/mockBackend.ts`):

- `startSession` picks one of a handful of canned "raw ASR" scripts (lowercase, unpunctuated,
  sprinkled with "um"/"uh") and returns a session id.
- `pushAudio` doesn't actually run recognition - it estimates how much audio-time has accumulated
  (from PCM chunk length / sample rate, or a flat estimate for compressed fallback chunks) and,
  roughly every 380ms of "speech", reveals the next word of the canned script via
  `onPartialTranscript`. This simulates a live streaming transcript without a real model.
- `endSession` returns the accumulated transcript and tears down the session.
- `cleanup` waits ~1s (simulating inference latency) then strips filler words (um/uh/erm/hmm),
  fixes capitalization, and adds terminal punctuation.
- `transform` waits ~600ms then applies a simple rule-based rewrite for `keypoints` / `formal` /
  `short` / `long`.
- `voiceEdit` recognizes a small set of command patterns (`"replace X with Y"`,
  `"delete the last sentence"`, `"delete the first sentence"`, `"add a period"`, `"uppercase
  everything"`) and no-ops on anything else.

All of the above is in `src/main/backend/textOps.ts` and `scripts.ts` if you want to see exactly
how the mock behaves.

The audio pipeline is shared by both backends: the renderer captures 16kHz mono PCM16 via an
AudioWorklet (falling back to MediaRecorder/webm if AudioWorklet is unavailable) and forwards raw
chunks over IPC as `AudioChunkPayload` (`{ kind: 'pcm16' | 'opaque', buffer, sampleRate }`), which
`backendIpc.ts` converts to `Int16Array`/`Buffer` before calling `pushAudio`.

## The real backend: LiteRT-LM

`LitertBackend` (`src/main/backend/litertBackend.ts`) implements `InferenceBackend` by talking to
[Google's LiteRT-LM runtime](https://github.com/google-ai-edge/LiteRT-LM), run out-of-process as
`litert-lm serve` - an OpenAI-compatible HTTP/SSE server. This is Option A from the
runtime's own de-risking notes: `litert-lm serve` already *is* the "wrapper exposing HTTP" this
app needs, so the app just spawns/talks to it rather than re-implementing an FFI binding.

### Architecture

```
Settings (backend, modelId, sidecar.*)
        │
        ▼
BackendController (src/main/backend/backendController.ts)
  - reads settings, decides Mock vs LiteRT-LM
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
  - accumulates PCM16 audio per session, periodically re-transcribes the whole buffer so far
    (partial transcripts) and again on endSession (final transcript)
  - cleanup/transform/voiceEdit as chat-completions prompts
  - all wire-format assumptions isolated in:
litertWire.ts (pure, unit-tested)
  - request builders: buildTranscriptionRequest / buildCleanupRequest / buildTransformRequest /
    buildVoiceEditRequest
  - response parsing: parseSSEBuffer, extractDeltaFromChatCompletionChunk,
    extractContentFromChatCompletionResponse, stripModelPreamble
  - audio encoding: concatInt16, pcm16ToWavBuffer/Base64
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
  empirically, a cold first request pays ~5.6s extra vs. ~1.4s once warm (E2B/CPU).

### Session lifecycle mapping

- `startSession` allocates an in-memory buffer for the session's PCM16 audio (no request to the
  sidecar yet).
- `pushAudio` appends to that buffer. Once ~3 seconds of *new* audio has accumulated, the entire
  buffer-so-far is WAV-encoded, base64'd, and sent as one transcription chat-completion; the
  result is emitted via `onPartialTranscript`. These requests are serialized - if the previous
  partial request is still in flight when the next 3-second mark is hit, that tick is skipped
  rather than firing a second overlapping request.
- `endSession` waits for any in-flight partial to finish, then does one final full-buffer
  transcription and returns it.
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
"Backend"/"Model"/"Sidecar" groups:

| Setting | Meaning |
|---|---|
| `backend` | `'mock'` or `'litert'` - which `InferenceBackend` to construct. |
| `modelId` | `'gemma-4-e2b' \| 'gemma-4-e4b' \| 'gemma-4-12b'` - which model `ModelManager` downloads/uses. |
| `sidecar.mode` | `'managed'` (app spawns the process) or `'external'` (you already have one running). |
| `sidecar.managedCommand` | Command template for managed mode. Default: `litert-lm serve --host 127.0.0.1 --port {port}` - `{port}` is substituted, then split into argv (quote-aware) and spawned directly (no shell). `{modelPath}` is also substituted if present, for custom wrapper scripts, but the real `litert-lm serve` CLI takes no model-selection flag at all (verified - see "What it assumes about the sidecar" above); this is a setting rather than a hardcoded invocation mainly so a non-default `litert-lm` install location or extra flags (e.g. `--cors-origin`) can be configured without a code change. |
| `sidecar.externalUrl` | Base URL for external mode, e.g. `http://127.0.0.1:9379` (litert-lm's real default port). |
| `sidecar.port` | Port used to build the local URL in managed mode, and substituted into `managedCommand`. |

### Model downloads

`ModelManager` (`src/main/backend/modelManager.ts`) downloads from the **ungated**
`litert-community/*` HuggingFace mirrors (Apache-2.0, no HF account/token needed):

| Model | HF repo | Sidecar alias | ~Size |
|---|---|---|---|
| Gemma 4 E2B | `litert-community/gemma-4-E2B-it-litert-lm` | `e2b` | ~2.4 GiB |
| Gemma 4 E4B | `litert-community/gemma-4-E4B-it-litert-lm` | `e4b` | ~3.4 GiB |
| Gemma 4 12B | `litert-community/gemma-4-12B-it-litert-lm` | `12b` | ~6.1 GiB |

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
install, model import, Settings configuration, dev run, `build:win`, and an honest writeup of
what's actually confirmed about GPU acceleration on the pip-installed CLI vs. what would require
the from-source build below). The rest of this section is a quick summary.

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
WSLg's OS-level audio-bridge plumbing is real, not a stub. What this *doesn't* prove: whether that
picks up an actual physical microphone on the Windows host (muted/absent input devices would still
pass the same `parecord` check with just noise-floor samples), and whether Chromium's
`getUserMedia()` inside Electron binds to it cleanly - that specific path wasn't separately
exercised here. Practically: treat WSL/WSLg as good enough for UI and backend development/demoing,
and use the Windows host ([WINDOWS.md](WINDOWS.md)) as the path for dictation you actually trust to
capture real speech.

GPU acceleration has the same CPU-only caveat here as documented for Windows in
[WINDOWS.md](WINDOWS.md#6-gpu-acceleration---honest-findings) - `litert-lm serve` doesn't route
Gemma-4 inference through a GPU today regardless of host OS.

## App features

1. **Dictate** - big record button; live streaming transcript while recording; automatic cleanup
   pass on stop; Key Points / Formal / Short / Long transform buttons; copy-to-clipboard button;
   optional auto-copy-on-cleanup (Settings); a small "voice edit command" box that exercises
   `voiceEdit` (e.g. `replace foo with bar`, `delete the last sentence`).
2. **History** - every completed dictation is persisted as JSON in Electron's `userData` dir
   (`history.json`), searchable by text, deletable, and clickable to reopen (re-loads the raw,
   cleaned, and last-transformed text plus its original stats into the Dictate screen).
3. **Settings** - backend selection (Mock / LiteRT-LM), model choice (Gemma 4 E2B / E4B / 12B)
   with per-model download/install state and a progress bar, sidecar mode/command/URL/port fields
   (only shown when LiteRT-LM is selected), offline/cloud toggle placeholder, custom vocabulary
   list (add/remove, persisted in `settings.json`), auto-copy toggle, and a global hotkey field
   that calls `globalShortcut.register` in the main process for real (default `Ctrl+Shift+Space`)
   - triggering it brings the window to front and toggles recording from anywhere in Windows.
4. **Session stats** - word count and words-per-minute, computed from the cleaned transcript and
   wall-clock recording duration, shown after every dictation.
5. **Backend status pill** - a small pill at the bottom of the sidebar showing the active
   backend's connectivity state (mock / starting / ready / error, with the error message as a
   tooltip), fed by `useBackendStatus` (`src/renderer/src/hooks/useBackendStatus.ts`).

## Local storage

Under Electron's `app.getPath('userData')` (on Windows, typically `%APPDATA%/windows-eloquent/`):

- `history.json` - array of `DictationEntry` (raw transcript, cleaned text, current display text,
  which transform (if any) produced it, word count, duration, WPM, timestamp)
- `settings.json` - the `Settings` object (backend selection, model id, sidecar config,
  offline/cloud mode, auto-copy, custom vocabulary, hotkey accelerator)
- `models/<modelId>.litertlm` - downloaded model files (see [Model downloads](#model-downloads));
  `models/<modelId>.litertlm.part` for an in-progress or interrupted download

## Development

```sh
npm install
npm run dev          # electron-vite dev server + Electron, with HMR
npm run typecheck    # tsc --noEmit for both the node (main/preload) and web (renderer) tsconfigs
npm run lint          # eslint (flat config, includes prettier + react-hooks rules)
npm test               # vitest - unit tests for litertWire.ts (request/response/SSE parsing,
                       # WAV encoding) and sidecar.ts's command templating, all pure functions
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
  ignore the requested sample rate and use the device default instead. Since `MockBackend` only
  uses chunk *duration* (not actual samples) to pace fake transcription, this doesn't affect the
  demo, but a real backend should resample defensively rather than assume exactly 16kHz.
- The MediaRecorder/webm fallback path (used only if `AudioWorklet` is unavailable) forwards
  opaque compressed bytes; `MockBackend` treats each chunk as "some audio arrived" rather than
  decoding it. `LitertBackend` can't decode it either (no bundled codec) and simply drops those
  chunks - the AudioWorklet/PCM16 path is the one that actually reaches the real model.
- `voiceEdit` has no dedicated screen mock-up in the original spec - it's exposed here as a small
  text-command input on the Dictate screen so the full `InferenceBackend` contract is actually
  exercised by the UI, not just implemented.
- **Superseded note**: an earlier draft of this doc said "this environment has no display server,
  so the Electron UI itself was never exercised here." That was true of the box this app was
  originally scaffolded on, but not of every environment it's since been run in - see
  [Running under WSLg](#running-under-wslg) above for a headed run (real window, real backend
  reaching "ready", screenshots captured) on a WSLg-enabled WSL2 box. What's *still* unexercised
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
  against the *old* backend when settings change mid-call - it only stops accepting new work on
  the old instance and stops the old sidecar process once the new one is ready. A dictation
  session started just before a backend switch should still be allowed to finish naturally.
- Packaging (`npm run build:win`) was intentionally **not** run - only the `electron-builder.yml`
  config (NSIS + portable, x64) was written and validated as parseable YAML.
