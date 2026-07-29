# Windows Eloquent

A Windows-targeted desktop clone of Google AI Edge Eloquent - an offline-first AI dictation app.
Record speech, get a live streaming transcript, an automatic cleanup pass, and one-tap transforms
(Key Points / Formal / Short / Long), all backed by an on-device model.

This repo is a **scaffold**: the app is fully wired end-to-end - UI, IPC, audio capture, local
history, settings, global hotkey - against a **mocked** inference backend, so it's runnable and
demoable today. The real model (Google LiteRT-LM running Gemma) is being integrated separately as
a drop-in replacement for the mock; see [Slotting in the real backend](#slotting-in-the-real-backend).

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
    backend.ts                InferenceBackend interface + wire types
    types.ts                  Settings, DictationEntry, etc.
    ipc-channels.ts           Centralized IPC channel name constants

  main/                     Electron main process (Node context)
    index.ts                  App bootstrap: creates the window, wires backend + stores + IPC,
                               registers the global hotkey
    hotkey.ts                  globalShortcut register/unregister helper
    backend/
      mockBackend.ts           MockBackend: the only InferenceBackend implementation today
      textOps.ts                cleanup / transform / voiceEdit text logic used by MockBackend
      scripts.ts                 Canned "recognized speech" used to fake streaming transcripts
    store/
      jsonStore.ts               Tiny generic JSON-file-backed store
      historyStore.ts            Dictation history persisted to userData/history.json
      settingsStore.ts           App settings persisted to userData/settings.json
    ipc/
      backendIpc.ts               Wires InferenceBackend <-> ipcMain
      historyIpc.ts               Wires HistoryStore <-> ipcMain
      settingsIpc.ts               Wires SettingsStore <-> ipcMain (+ re-registers hotkey on change)

  preload/                  contextBridge boundary
    index.ts                  Exposes a typed `window.api` (dictation / history / settings / hotkey)
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
      screens/                 DictateScreen, HistoryScreen, SettingsScreen
      components/              RecordButton, TransformBar, StatsBar, VoiceEditBar, Sidebar, Toggle, Icons
      lib/                     format.ts (word count / WPM), clipboard.ts
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

Today the only implementation is `MockBackend` (`src/main/backend/mockBackend.ts`):

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

## Slotting in the real backend

The real backend (Google LiteRT-LM running Gemma 4, per the model-selection placeholders in
Settings) is expected to run as a **subprocess sidecar** - spawned by the main process, talked to
over stdio or a local socket, its output adapted into partial/final transcripts and text
transforms.

To swap it in:

1. Implement a class, e.g. `LiteRtBackend implements InferenceBackend`, in
   `src/main/backend/liteRtBackend.ts`. It should:
   - spawn the sidecar process in its constructor (or lazily on first `startSession`)
   - implement `startSession`/`pushAudio`/`endSession` by streaming audio to the sidecar and
     parsing partial-transcript messages back out, re-emitting them via the same
     `onPartialTranscript` subscribe/unsubscribe shape `MockBackend` uses
   - implement `cleanup`/`transform`/`voiceEdit` as prompts to the sidecar's generation endpoint
2. In `src/main/index.ts`, change:
   ```ts
   const backend = new MockBackend()
   ```
   to:
   ```ts
   const backend = new LiteRtBackend(/* model path, settings, etc. */)
   ```
3. Nothing else changes. `src/main/ipc/backendIpc.ts`, the preload bridge, and every React
   component/hook only depend on the `InferenceBackend` interface, not on `MockBackend`.

The audio pipeline is already designed for this: the renderer captures 16kHz mono PCM16 via an
AudioWorklet (falling back to MediaRecorder/webm if AudioWorklet is unavailable) and forwards raw
chunks over IPC as `AudioChunkPayload` (`{ kind: 'pcm16' | 'opaque', buffer, sampleRate }`), which
`backendIpc.ts` converts to `Int16Array`/`Buffer` before calling `pushAudio`. A real backend that
wants raw PCM bytes for LiteRT-LM already gets them in the preferred format.

## App features

1. **Dictate** - big record button; live streaming transcript while recording; automatic cleanup
   pass on stop; Key Points / Formal / Short / Long transform buttons; copy-to-clipboard button;
   optional auto-copy-on-cleanup (Settings); a small "voice edit command" box that exercises
   `voiceEdit` (e.g. `replace foo with bar`, `delete the last sentence`).
2. **History** - every completed dictation is persisted as JSON in Electron's `userData` dir
   (`history.json`), searchable by text, deletable, and clickable to reopen (re-loads the raw,
   cleaned, and last-transformed text plus its original stats into the Dictate screen).
3. **Settings** - model placeholder (Gemma 4 E2B / E4B / 12B), offline/cloud toggle placeholder,
   custom vocabulary list (add/remove, persisted in `settings.json`), auto-copy toggle, and a
   global hotkey field that calls `globalShortcut.register` in the main process for real (default
   `Ctrl+Shift+Space`) - triggering it brings the window to front and toggles recording from
   anywhere in Windows.
4. **Session stats** - word count and words-per-minute, computed from the cleaned transcript and
   wall-clock recording duration, shown after every dictation.

## Local storage

Both stores are flat JSON files under Electron's `app.getPath('userData')` (on Windows, typically
`%APPDATA%/windows-eloquent/`):

- `history.json` - array of `DictationEntry` (raw transcript, cleaned text, current display text,
  which transform (if any) produced it, word count, duration, WPM, timestamp)
- `settings.json` - the `Settings` object (model id, offline/cloud mode, auto-copy, custom
  vocabulary, hotkey accelerator)

## Development

```sh
npm install
npm run dev          # electron-vite dev server + Electron, with HMR
npm run typecheck    # tsc --noEmit for both the node (main/preload) and web (renderer) tsconfigs
npm run lint          # eslint (flat config, includes prettier + react-hooks rules)
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
  decoding it. A real backend would need to either decode webm/opus itself or prefer the PCM path.
- `voiceEdit` has no dedicated screen mock-up in the original spec - it's exposed here as a small
  text-command input on the Dictate screen so the full `InferenceBackend` contract is actually
  exercised by the UI, not just implemented.
- This environment has no display server, so the Electron GUI itself was never launched here.
  Verification is `npm run typecheck` + `npm run build` succeeding; the actual window, mic
  capture, and global hotkey behavior should be manually smoke-tested on a real Windows machine.
- Packaging (`npm run build:win`) was intentionally **not** run - only the `electron-builder.yml`
  config (NSIS + portable, x64) was written and validated as parseable YAML.
