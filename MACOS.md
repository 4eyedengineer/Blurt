# Running Blurt from source on macOS

**macOS support is implemented but has not been run on real Apple Silicon hardware.** The
darwin-specific logic - venv/Python discovery (`venvResolver.ts`, `firstRunSetup.ts`), Accessibility
gating (`pushToTalkController.ts`), Cmd+V paste injection (`paste.ts`), the tray/menu-bar icon
(`tray.ts`), and macOS process lookups (`portGuard.ts`) - is unit-tested by parameterizing pure
functions with `platform: 'darwin'` and asserting their output. That's real coverage, and it's more
than nothing, but a test asserting `venvPathsFor(dir, 'darwin')` returns the right posix path is not
the same thing as watching venv creation actually happen on a Mac. Nobody on this project owns
Apple Silicon hardware, so nothing below has actually been launched, clicked through,
GPU-benchmarked, signed, or notarized on a real machine. Treat this document as an accurate account
of what the code does and why, not as a verified how-to - the "Unverified" section near the end
lists every specific claim above it that still needs a real machine to confirm.

If you just want to _use_ Blurt, you don't need any of this. See the main [README.md](README.md)
for the installer download.

This assumes you've read [CONTRIBUTING.md](CONTRIBUTING.md)'s "The real backend: LiteRT-LM"
section for the wire-protocol/architecture background; this doc is the macOS-specific how-to. It
deliberately does not mirror [WINDOWS.md](WINDOWS.md) section-for-section - there's no registry, no
NSIS installer, a real OS permissions model instead of none, and Python is found by absolute path
instead of a `py` launcher. Where the mechanism really is identical to Windows (the GPU wrapper
script, the effective-backend marker, the model download/import flow), this says so and points at
WINDOWS.md rather than repeating it.

## 1. Install Python 3.10+

Blurt provisions its own Python virtual environment on first launch (see "Run in dev" below) - it
just needs a real Python 3.10 or newer already present on the machine to create that venv from.
Get one with Homebrew:

```sh
brew install python@3.12
```

or a [python.org](https://www.python.org/) installer for macOS. Confirm with:

```sh
python3.12 --version
```

**Do not rely on the Python that ships with macOS.** `/usr/bin/python3` is not a full interpreter;
it's the Xcode Command Line Tools' stub. If the Command Line Tools aren't installed, invoking it
doesn't fail with a normal error - it pops a blocking system dialog asking whether to install the
Command Line Tools, which is not what you want in the middle of a background probe (see "Run in
dev" below) or when you're just trying to check a version number in Terminal. If the Command Line
Tools _are_ installed, its bundled Python has never shipped 3.10 or newer anyway. Blurt's own
Python discovery (`src/main/runtime/firstRunSetup.ts`) knows about this and deliberately never
probes `/usr/bin/python3` at all.

## 2. Install Node.js

Blurt needs **Node.js >= 20.19.0, or >= 22.12.0** - the same requirement as Windows, for the same
reason (Vite's config loader calls Node's `crypto.hash()`, added in 21.7.0 and backported to
20.12.0; anything in the 20.12-20.18 or 21.0-21.6 ranges fails immediately with `TypeError:
crypto.hash is not a function`). See [WINDOWS.md](WINDOWS.md) step 2 for the full version-range
detail if you land in that gap.

```sh
brew install node
node --version
```

## 3. Run in dev (`npm run dev`)

```sh
git clone <repo-url> ~/src/blurt
cd ~/src/blurt
npm install
npm run dev
```

Unlike a from-scratch Windows walkthrough, there's no separate "pip install litert-lm and import a
model by hand first" step required before this works. WINDOWS.md's steps 3-4 are the manual
equivalent of what happens automatically below, and stay useful if you want to drive `litert-lm`
directly for debugging - the CLI ends up at
`~/Library/Application Support/Blurt/venv/bin/litert-lm` once first-run setup below has run, and
behaves identically to the Windows build. A source checkout and a packaged build go through the
exact same automatic bootstrap: `ensureRuntime()` in `src/main/index.ts` runs unconditionally in
dev mode too, on both win32 and darwin (`isRuntimeManagedPlatform`) - it never checks
`app.isPackaged`.

**What first launch does**, if no healthy venv is found at
`~/Library/Application Support/Blurt/venv`:

1. Shows a setup window with a step list and a live log.
2. Finds a Python 3.10+ interpreter by probing absolute paths, in order, until one succeeds:
   Homebrew's `python3.12`, `python3.11`, then `python3` (three candidates, all under
   `/opt/homebrew/bin` - the Apple Silicon prefix; Blurt ships arm64-only, so Intel Homebrew's
   `/usr/local` is never checked), then python.org's Framework install path at `3.12` then `3.11`
   (two more candidates, no unversioned fallback there), and only then a bare `python3`/`python`
   off `PATH` as a last resort (two final candidates). Each probe is killed after 5 seconds if it
   hangs, so a wedged interpreter can't hang Blurt's startup with nothing on screen to explain why.
   `/usr/bin/python3` is never one of the candidates - see "Install Python 3.10+" above for why.
3. Creates the venv at `~/Library/Application Support/Blurt/venv` (`python -m venv`).
4. Upgrades pip, then installs the pinned `litert-lm==0.14.0` into it - the same version pin
   Windows uses (`LITERT_LM_PINNED_VERSION` in `src/main/runtime/firstRunSetup.ts` is a single
   constant, not platform-conditional).

If no Python 3.10+ can be found, Blurt shows a hard error screen with this exact text
(`noPythonFoundMessage('darwin')`):

> No Python 3.10+ installation was found. Install it with Homebrew ("brew install python@3.12") or
> a python.org installer for macOS, then relaunch Blurt. (macOS's built-in /usr/bin/python3 is just
> an Xcode Command Line Tools stub, not a full interpreter, so it does not count.)

**Where things live.** On Windows, the runtime venv (`%LOCALAPPDATA%\Blurt`) and the app's own data
(`%APPDATA%\blurt` - settings, history, models) are two different directories. On macOS they are
the same directory: `app.getPath('userData')` and the runtime base dir both resolve to
`~/Library/Application Support/Blurt`, so `venv/`, `settings.json`, `history.json`, `models/`,
`litert-lm-home/` (the app's own sandboxed `LITERT_LM_DIR`, separate from your real
`~/.litert-lm`), and `logs/main.log` all sit side by side in one folder. `venvResolver.ts` derives
the venv location independently rather than reusing `app.getPath('userData')` directly, so the two
paths agreeing on macOS is a coincidence, not a code dependency - don't build tooling that assumes
it.

Once the setup window closes, open **Settings** and hit Download on a model exactly as on Windows;
the in-app downloader resolves and imports it via the venv's own `litert-lm` CLI, same as
`ModelManager` does on every platform (see CONTRIBUTING.md's "Model downloads").

## 4. The two permissions

Blurt asks macOS for two separate permissions. Neither is requested at launch; each is requested
the first time it's actually needed.

### Microphone

Prompted the first time you actually start recording (Dictate tab or push-to-talk). Declared via
`NSMicrophoneUsageDescription` in `electron-builder.yml`'s `mac.extendInfo`:

> Blurt needs microphone access to transcribe your dictation. Audio is processed entirely on this
> Mac and never leaves your device.

This isn't optional the way the entitlement below is deferrable: hardened runtime kills a process
outright the moment it touches an audio input device without this Info.plist key present, rather
than showing a denial dialog. If you build your own unsigned copy and recording fails silently,
this is the first thing to check.

### Accessibility

Required for two unrelated features that both happen to need it: the global push-to-talk key hook,
and auto-paste (which synthesizes Cmd+V into whatever app you were dictating into). Grant it at
**System Settings > Privacy & Security > Accessibility**.

**Push-to-talk refuses to arm without it, on purpose.** Starting the global key hook
(`uIOhook.start()`, from `uiohook-napi`) installs a CGEventTap, which macOS refuses to create
without this permission - and calling it anyway is a known way to crash the whole Electron process
rather than fail cleanly (see SnosMe/uiohook-napi issue #24). `PushToTalkController` checks
`systemPreferences.isTrustedAccessibilityClient(false)` (a non-prompting query) before every
attempt to start the hook, and simply doesn't start it if the permission isn't there - including
when the permission state can't be determined at all (queried as `null`, treated the same as
`false`: there's no way to tell "safe" from "not safe" apart, so it refuses rather than guesses).
Settings shows an **Open System Settings** button next to push to talk whenever
`accessibilityGranted === false`; it calls the _prompting_ form of the same API
(`isTrustedAccessibilityClient(true)`), which is what actually deep-links to the System Settings
pane, then immediately re-checks and starts the hook if you just granted it - no relaunch needed.

**Auto-paste fails with a specific message when this is the cause.** Everywhere else, a failed
paste falls back to "Paste failed. The text is on your clipboard." - but when the underlying
`osascript` command fails because Accessibility isn't granted, that's detected (matching "assistive
access" in the error text, or Apple's `-1719` error code) and reported instead as:

> Paste failed. Grant Blurt Accessibility access in System Settings > Privacy & Security >
> Accessibility - the text is on your clipboard.

Either way, the clipboard write always happens first and always succeeds independently of paste
injection - a failed auto-paste never costs you the dictation itself.

**This permission is tied to the app's code signature, not to "Blurt" as a concept.** Rebuild an
unsigned or ad-hoc-signed copy and macOS treats it as a new, never-before-seen app - the
Accessibility grant you gave the previous build does not carry over, and you'll need to grant it
again after every rebuild. This is why signing matters for local development on this feature
specifically, not only for distribution; see "Signing and notarization" below.

## 5. GPU acceleration: Metal, and how to tell what you actually got

**Short version: the exact same mechanism as Windows is implemented, unmodified, and the compiled
native library really does contain Metal code - but nobody has run it, so whether the engine
actually initializes on Metal for the Gemma-4 model, and what the throughput is, remains
unverified.** See [WINDOWS.md](WINDOWS.md)'s GPU section for the full mechanism this builds on;
this section only covers what's different (the backend Dawn picks) and what's identical
(everything else).

### Same wrapper, different Dawn backend

GPU acceleration goes through **Dawn (WebGPU)**, exactly as on Windows - `resources/serve_gpu.py`
is not platform-specific code; it's the same file, monkeypatching the same
`litert_lm_cli.commands.serve_util` function to force the main model onto GPU regardless of the
model file's `cpu` backend constraint (see WINDOWS.md's "Finding 2"). What differs is which native
graphics API Dawn compiles down to: **Direct3D 12 on Windows, Metal on macOS.** Nothing in Blurt or
`serve_gpu.py` picks this - it's decided entirely by which native library shipped in the
`litert-lm-api` wheel for each platform.

`DEFAULT_MANAGED_COMMAND` (`src/shared/types.ts`) is the same template on every platform -
`"{venvPython}" "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose` - substituting the
darwin venv's own `bin/python` and the same `serve_gpu.py`. There is no separate macOS code path to
opt into or out of.

### The evidence, and exactly what it does and doesn't prove

Inspecting the actual shipped native libraries (not documentation) with `strings`:

|                                        | macOS `liblitert-lm.dylib` | Windows equivalent DLL |
| -------------------------------------- | -------------------------- | ---------------------- |
| `"Metal"` occurrences                  | 884                        | 24                     |
| `"MTLDevice"` occurrences              | 84                         | 1                      |
| `"MTLCreateSystemDefault"` occurrences | 2                          | 0                      |

The Windows wheel additionally ships `dxcompiler.dll` (18 MB) and `dxil.dll` for D3D12 shader
compilation; the macOS wheel ships neither, because Metal's shader compiler is part of the OS, not
a bundled library.

**This is static evidence from the binary, not a runtime test.** It shows the Metal code path is
really compiled into the macOS build, not just documented as theoretically supported upstream. It
does not show the engine successfully initializes on Metal for the Gemma-4 model, and it says
nothing about throughput. Both are currently unknown - see "Unverified" below.

### Unified memory changes the sizing question, not just the backend

WINDOWS.md's "budget at least 4 GB of VRAM" floor doesn't translate to Apple Silicon: GPU and CPU
share one pool of memory there, so there is no separate VRAM budget to hit in the first place. RAM
is the only thing that matters, and Blurt's existing RAM check already covers it -
`requiredRamBytes` (`src/shared/modelRequirements.ts`) is just model size plus 2 GiB of headroom,
computed identically on every platform. Consistent with this, Blurt never shows a VRAM figure on
macOS: `probeHardware` (`src/main/hardware/hardwareProbe.ts`) only runs its GPU-enumerating branch
on `win32`; every other platform, including darwin, gets an empty GPU list, so
`checkModelRequirements`'s "not enough VRAM" note - which only ever fires when a VRAM figure is
actually known - never fires on macOS. That's a deliberate "say nothing rather than guess," not a
missing feature.

### How to tell what backend you actually got

The same two places Windows uses, unchanged:

- **Settings.** The "Running on GPU" / "Running on CPU" line
  (`src/renderer/src/screens/SettingsScreen.tsx`) reads `BackendStatus.effectiveAccelerator`, which
  is never a guess - it only ever reflects what `serve_gpu.py` actually reported (see below), and
  shows nothing at all while the sidecar isn't running.
- **`main.log`** (`~/Library/Application Support/Blurt/logs/main.log`). Grep for
  `effective-backend=`:

  ```
  sidecar: effective-backend=gpu
  ```

  This comes from the same `BLURT_EFFECTIVE_BACKEND=gpu`/`=cpu` marker line `serve_gpu.py` prints
  on every platform once engine creation has resolved one way or the other
  (`parseEffectiveBackendLine` in `src/main/backend/sidecar.ts`). On its own this only means
  "engine creation didn't raise" - not confirmed GPU execution - so `sidecar.ts` separately watches
  the child's stdout/stderr for one of two native-library log lines that corroborate a real GPU
  selection, and logs whichever it saw first:

  ```
  sidecar: observed GPU corroboration (selected-adapter)
  sidecar: observed GPU corroboration (main-executor-settings)
  ```

  `MainExecutorSettings: backend: GPU` is backend-agnostic - it doesn't name Metal or D3D12, just
  GPU-vs-CPU - and is confirmed present in the macOS binary's strings, so this half of the
  corroboration check is on solid ground. Dawn's own adapter line is expected to read something
  like `Selected adapter: Apple M-series GPU, ..., backend=Metal, adapterType=Integrated GPU` (by
  analogy with Windows' captured `backend=Direct3D 12, adapterType=Discrete GPU` line, and because
  Apple Silicon's GPU is architecturally integrated, never discrete) - but that exact line has not
  itself been captured from a real run, only the surrounding `"Selected adapter: "` substring is
  confirmed present in the binary. If the marker claims GPU but neither corroboration line ever
  showed up, you'll see this instead:

  ```
  sidecar: BLURT_EFFECTIVE_BACKEND=gpu reported but unconfirmed - looked for a "Selected adapter:
  ... GPU" or "MainExecutorSettings: backend: GPU" line in the child's stdout/stderr and found
  neither; the marker only reflects that engine creation did not raise, not confirmed GPU execution.
  ```

  That WARNING line existing at all is exactly the kind of thing worth watching for on a first real
  Apple Silicon run.

- **Activity Monitor.** Window > GPU History, or add the "% GPU" column to the process list (View >
  Columns), and look for the venv's `python` process while a dictation is in flight. There's no
  Apple Silicon equivalent of `nvidia-smi`; Activity Monitor is the closest thing.

## 6. Building a distributable (`npm run build:mac`)

```sh
npm run build
npm run build:mac
```

`npm run build:mac` is `npm run build && electron-builder --mac` (`package.json`). Must run on a
real Mac - electron-builder cannot cross-build a macOS target from Windows or Linux.

**arm64 only, deliberately.** `electron-builder.yml`'s `mac:` block targets `dmg` for `arch:
arm64` only, because `litert-lm-api` (the engine dependency the app's venv pip-installs on first
run) has published only a `macosx_12_0_arm64` wheel on PyPI in every release from 0.12.0 through
0.14.0 - no `x86_64`, no `universal2`. A universal or x64 build would install and launch fine on an
Intel Mac (Electron itself doesn't care), then fail later, during first-run setup, when pip has no
matching wheel to install - a worse, later, more confusing failure than not offering an Intel build
at all. `minimumSystemVersion: '12.0'` matches that same wheel's floor; there's no point installing
on an older macOS just to hit the identical pip failure.

Other `mac:` settings, from `electron-builder.yml`:

- `category: public.app-category.productivity`
- `icon: build/icon.icns` - see "Unverified" below for two open questions about this specific file.
- `hardenedRuntime: true`, with `entitlements`/`entitlementsInherit` both pointing at
  `build/entitlements.mac.plist` (see "Signing and notarization" below).
- `extendInfo` injects `NSMicrophoneUsageDescription` into `Info.plist` (see "The two permissions"
  above) - electron-builder has no dedicated field for this key, so it's added via the generic
  extra-keys mechanism.

**`disableAsarIntegrity: true` is a top-level setting, not scoped to `win:`.** It was added to fix
a real Windows-only startup crash (a resedit-injected INTEGRITY resource that made `blurt.exe` exit
silently on every launch - see the comment above it in `electron-builder.yml`), and because
electron-builder has no per-platform variant of this flag, it applies to the mac build too, as
written, whether or not it does anything there. Nobody has built on a Mac yet to find out whether
disabling it fixes a real problem, is a total no-op, or (least likely, but not ruled out) causes a
different one - see "Unverified" below.

**The native push-to-talk module.** `uiohook-napi` ships prebuilt N-API binaries per platform,
including `darwin-arm64`. `postinstall` runs `electron-builder install-app-deps`, falling back to a
warning (not a failure) if it can't rebuild native modules - the same safety net WINDOWS.md
describes for a machine without Visual Studio Build Tools, except here the fallback path is the
expected one on any Mac without a full native build toolchain installed, not just a
to-be-tolerated edge case.

## 7. Signing and notarization

**Distribution requires a Developer ID Application certificate**, which requires enrolling in the
Apple Developer Program (currently $99/year). electron-builder reads three environment variables to
drive notarization: `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, and `APPLE_TEAM_ID`. Without these
set, `build:mac` produces an unsigned (or ad-hoc-signed) `.dmg` that macOS's Gatekeeper will block
on first open.

**Hardened runtime is on**, which locks the process down by default - no JIT, no unsigned
executable memory, no unvalidated libraries - unless specific entitlements relax it.
`build/entitlements.mac.plist` grants exactly three:

- `com.apple.security.device.audio-input` - microphone capture; pairs with
  `NSMicrophoneUsageDescription` above.
- `com.apple.security.cs.allow-jit` - Electron's V8 needs to JIT-compile JS at runtime; Electron's
  own docs call this out specifically for Apple Silicon, where a hardened-runtime build without it
  crashes on launch, not on first script execution.
- `com.apple.security.cs.allow-unsigned-executable-memory` - paired with `allow-jit`: V8's JIT
  allocates executable pages not backed by a signed file on disk, which hardened runtime otherwise
  refuses to execute.

**`com.apple.security.cs.disable-library-validation` is deliberately left off.** The reasoning,
recorded in the entitlements file itself: library validation requires every loaded dylib/bundle to
share the main executable's Team ID (or be an Apple system library). The only native code Blurt
loads in-process is `uiohook-napi` - everything else (the Python interpreter, `litert-lm`) runs as
a completely separate OS process via `child_process.spawn`, never `dlopen`'d into this process, so
library validation never applies to it at all. electron-builder's signing step re-signs every
Mach-O bundled inside the `.app`, including native `node_modules` addons, under the same Developer
ID as the main executable - so `uiohook-napi`'s Team ID should end up matching and pass validation
without needing this entitlement. That reasoning depends on a **real Developer ID identity being
used**, not ad-hoc/no signing; if a real build turns up a library-validation rejection anyway, this
is the first entitlement to add.

**App Sandbox is deliberately absent.** Blurt synthesizes keystrokes into whatever app you're
dictating into (Accessibility-gated auto-paste) and spawns a user-installed Python interpreter as
an arbitrary child process - both are exactly what App Sandbox exists to prevent, and a sandboxed
process cannot use the Accessibility API at all regardless of TCC permission. Adding
`com.apple.security.app-sandbox` would not harden Blurt; it would break two of its features
outright.

None of this - hardened runtime, entitlements, or notarization - has been exercised against a real
signing identity yet.

## Unverified

Every item below follows documented Apple/Electron/`litert-lm` behavior and first-principles
reasoning about what this specific app does, not firsthand confirmation. Read this before trusting
anything above on hardware you care about.

- **Whether the engine actually initializes on Metal for the Gemma-4 model, and its throughput.**
  The Metal code path is confirmed compiled into the native library (see "GPU acceleration"
  above); whether it actually runs, and how fast, is not. WINDOWS.md quotes real measured tokens/s
  from a discrete NVIDIA GPU; there is no macOS number to quote yet, and none should be assumed by
  analogy.
- **The menu bar icon renders as a solid silhouette, not the coloured mark.** It's set as a macOS
  "template image" (`shouldUseTemplateImage` in `src/main/tray.ts`), which is necessary for it to
  invert correctly on dark/light menu bars and when highlighted - but a template image derives its
  shape from the source PNG's alpha channel only, discarding all colour. `resources/icon.png` is a
  full-colour mark, so this is expected to look like a plain speech-bubble silhouette, not a bug if
  so. A dedicated monochrome asset is probably wanted eventually. Also unconfirmed: whether a
  512px-to-22px downscale of this particular source asset still reads cleanly at menu-bar size once
  forced through that silhouette rendering.
- **`build/icon.icns` has two known rough edges**, both artifacts of having been generated on
  Linux rather than a Mac: it has 8 slots from 32px to 1024px but no distinct 16x16@1x slot (a
  limitation of the encoder used), and it's full-bleed, where macOS convention gives app icons
  padding inside the rounded-square. Worth a look on a Mac before shipping it widely.
- **The "Blurt is still running" tray hint may not appear at all.** It uses macOS's `Notification`
  API (`showTrayHint` in `src/main/tray.ts`), which - independent of anything Blurt does - macOS
  may decline to show at all for an unsigned or un-notarized development build, and may not even
  prompt for Notification Center permission for one. The code checks `Notification.isSupported()`
  and logs either way, which is how to tell "this ran but the OS ate it" from "this never ran" once
  someone can check on real hardware.
- **`disableAsarIntegrity: true` (`electron-builder.yml`) is untested on macOS.** It's a top-level
  setting that was added to fix a Windows-specific startup crash; whether it does anything at all
  on macOS, or is simply inert there because the PE-specific mechanism it targets has no macOS
  equivalent, is unknown.
- **The Accessibility crash-avoidance logic has never hit a real CGEventTap.**
  `canStartGlobalHook`/`PushToTalkController` refuse to call `uIOhook.start()` without the
  Accessibility permission because doing so is a documented way to crash Electron (SnosMe/
  uiohook-napi issue #24) - but this project has never actually attempted that call on real macOS
  to confirm either the crash or the refusal-avoids-it behaviour firsthand.
- **Cmd+V synthesis via `osascript`/System Events is unverified**, both the happy path
  (`buildMacosOsascriptArgs` in `src/main/paste.ts`) and the Accessibility-denied failure path
  (`describePasteFailure`'s loose match on "assistive access" / error `-1719`). Also worth knowing:
  there is no `--clearmodifiers`-equivalent flag for System Events the way `xdotool` has on Linux,
  so the 150ms paste-settle delay is doing more work on macOS than on the other two platforms to
  keep a still-held modifier key out of the synthesized keystroke.
- **`portGuard.ts`'s macOS process lookups (`lsof`, `ps -ww -o command=`) are based on documented
  BSD-userland output formats, not a captured real run.** If Blurt ever reports a port conflict it
  can't identify the owner of on macOS, this is the first place to check.
- **Signing, notarization, and every hardened-runtime entitlement decision** (see "Signing and
  notarization" above) follow Apple's and Electron's own documentation, not a real signed build.

## Summary checklist

- [ ] `brew install python@3.12` (or any 3.10+ from Homebrew or python.org - never rely on
      `/usr/bin/python3`)
- [ ] `brew install node` and confirm `node --version` is >= 20.19.0 (or >= 22.12.0)
- [ ] `npm install && npm run dev` - first launch bootstraps its own venv under
      `~/Library/Application Support/Blurt/venv` automatically, the same as a packaged build
- [ ] Grant Microphone access when prompted; grant Accessibility (System Settings > Privacy &
      Security > Accessibility) if you want push-to-talk or auto-paste - see "The two permissions"
- [ ] In Settings, download a model - same in-app flow as Windows
- [ ] GPU acceleration via Metal is implemented the same way as Windows' Direct3D 12 path, and the
      Metal code is confirmed compiled into the shipped library - but it has NOT been run on real
      Apple Silicon; see "GPU acceleration" and "Unverified" above before assuming it works
- [ ] `npm run build && npm run build:mac` on a real Mac to produce an arm64 dmg; needs a Developer
      ID certificate + notarization to distribute without a Gatekeeper block (see "Signing and
      notarization")
- [ ] Read "Unverified" above before relying on any of this for anything that matters
