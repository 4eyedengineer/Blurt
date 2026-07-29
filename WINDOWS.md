# Running Windows Eloquent on Windows (RTX 3060)

This is the practical setup guide for running the real LiteRT-LM backend on a Windows host, as
opposed to the Mock backend or Linux/WSL2 dev/test loop. It assumes you've already read the
"[The real backend: LiteRT-LM](README.md#the-real-backend-litert-lm)" section of the README - this
doc is the Windows-specific how-to; the README has the wire-protocol/architecture background.

Everything below was verified empirically against a real `litert-lm` 0.14.0 pip install (see
`scripts/integration-live.mjs` and `scratchpad/sidecar-verification.md` for the raw evidence) - not
guessed from documentation. The one thing *not* independently verified on this machine is actual
GPU execution, since the dev sandbox this app was built in has no Vulkan-capable GPU; the "GPU
acceleration" section below is explicit about what's confirmed vs. inferred.

## Quick start: one-click launcher

Steps 1-4 below (Python, the `litert-lm` CLI, importing a model, configuring the app) are
automated by **`run-windows.bat`** at the repo root - double-click it (it just runs
`Start-Eloquent.ps1` with `-ExecutionPolicy Bypass`, so it works even if PowerShell script
execution is locked down on your machine) and it will:

- **if your source checkout lives on a UNC/WSL path** (e.g. you opened this repo via
  `\\wsl.localhost\<distro>\...` in Explorer, which is the common case when developing inside WSL) -
  mirror it with `robocopy /MIR` to a Windows-local working copy under
  `%LOCALAPPDATA%\WindowsEloquent\app`, and do everything below *there* instead of on the network
  path. **Source of truth stays in WSL** - this is a one-way, repeatable sync (not a copy-once): the
  mirror is excluded from the copy for `node_modules`, `.runtime`, `out`, `dist`, and `.git`, so
  re-running the launcher after you change code re-syncs your changes into the same working copy,
  without ever re-downloading the model or rebuilding the venv (those live under
  `%LOCALAPPDATA%\WindowsEloquent`, a sibling of `app`, untouched by the sync). If instead your
  checkout is already on a real Windows drive (e.g. you `git clone`d directly onto `C:\...` rather
  than developing through WSL), it skips the mirror step entirely and bootstraps in place.
- install Python 3.12 via `winget` if missing
- install/upgrade Node.js via `winget` to satisfy the **Node >= 20.19 (or >= 22.12) requirement**
  below - see "Node.js version requirement" for why this specific floor and what the script does
  about it, both on a fresh machine and on a machine that already has a too-old Node
- create a `litert-lm` venv under `%LOCALAPPDATA%\WindowsEloquent\venv` and `pip install litert-lm`
  into it (skips this if already done)
- `npm install` if `node_modules` is missing, or if it was last installed with a different Node
  version than the one this run resolved (in the working copy above; see "Node.js version
  requirement" below)
- download + import the Gemma E2B model into the app's own model store if it isn't there yet
  (reusing an existing local copy instead of re-downloading ~2.4 GiB, if one is found)
- seed an initial `settings.json` with the real LiteRT-LM backend already enabled - **only** on the
  very first run, so it never clobbers a config you've since changed
- run `npm run dev` (in the working copy above)

Re-running it is safe: every step checks what's already done and skips it - including the
robocopy sync, which just re-mirrors whatever changed.

### Node.js version requirement

This project needs **Node.js >= 20.19.0, or >= 22.12.0** - not just "any recent Node." That's
Vite's own `engines` requirement (`node_modules/vite/package.json` once installed), and it's a hard
requirement, not a soft recommendation: Vite's config loader calls the Node built-in
`crypto.hash()`, which was added in Node 21.7.0 and backported to 20.12.0. Anything in the
20.12-20.18 or 21.0-21.6 ranges either lacks `crypto.hash()` entirely or fails Vite's own engines
check, and `npm run dev` dies immediately on startup with:

```
TypeError: crypto.hash is not a function
    at getHash (.../node_modules/vite/dist/node/chunks/config.js:...)
```

`Start-Eloquent.ps1` checks the resolved Node's version **on every run** (not just the first) and,
if it's missing or too old, runs `winget install -e --id OpenJS.NodeJS.LTS` to install/upgrade it
in place, then re-resolves `node.exe`/`npm.cmd` directly (refreshing this process's `PATH` from the
machine+user registry, since a just-completed `winget install` doesn't update an already-running
shell's `PATH`) rather than trusting a possibly-stale `PATH` lookup. If that still can't find a
new-enough Node afterward (e.g. an older install shadowing the new one earlier on `PATH`), it prints
an error and asks you to close the window and re-run in a fresh terminal.

Because a stale-Node `npm install` can leave `node_modules` resolved/built against the wrong
engines/ABI, the script also stamps the Node major.minor version used for the last successful `npm
install` in a `.node-version-stamp` file next to `node_modules`, and re-runs `npm install`
automatically whenever the detected Node version no longer matches that stamp (including the first
time this check runs against a pre-existing `node_modules` with no stamp yet at all) - not just when
`node_modules` is missing outright.

Set `$env:ELOQUENT_DRYRUN` (see below) to check what Node the script would use/install without
actually installing/upgrading anything.

Why the mirroring step exists at all: a Windows-native `npm`/`node`/Electron cannot run against a
`node_modules` tree that was `npm install`ed on Linux (native addons, the Electron binary itself -
all built for Linux), and npm's lots-of-small-files I/O pattern is slow and occasionally flaky
against a `\\wsl.localhost\` (or any UNC) share. Mirroring to a real local Windows drive first
avoids both problems. If you'd rather not have a second copy of the source at all, see "Alternative:
clone natively on Windows" below.

**Testing note**: `run-windows.bat`/`Start-Eloquent.ps1` were exercised from a WSL2 sandbox using
`cmd.exe`/`powershell.exe` interop against a real Windows host (no GUI/mouse available there) - the
UNC-path detection, the `pushd`-based cwd fix, the robocopy plan (via `ELOQUENT_DRYRUN=1`, see
below), and the "bootstrap in place on a local drive" branch were all confirmed to resolve paths
correctly and run cleanly. What could **not** be verified from WSL: an actual Explorer double-click
(mouse-driven GUI interaction - the interop testing used `cmd.exe /c <fully-qualified path>`, which
is what the "open" file-association verb Explorer uses for `.bat` files resolves to), a `winget`
install of a missing Python/Node (deliberately not exercised to avoid mutating the test machine),
`net use`-mapping a drive letter onto a `\\wsl.localhost\...` path specifically (Windows' `net use`
doesn't support that provider - it's a `pushd`/Explorer/DrvFs thing, not classic SMB - so that one
sub-case of the "mapped drive" detection is unverified, though the same WMI-based check was
confirmed to correctly say "not remote" for an ordinary local drive), and a real end-to-end model
download + `npm run dev` launch on Windows. Skim the script before your first real run, and please
report back anything that doesn't match your machine so it can be corrected.

Set `$env:ELOQUENT_DRYRUN` to any value other than `""`/`0` before running `run-windows.bat` (or
`Start-Eloquent.ps1` directly) to print the resolved source/working-copy paths and the robocopy plan
and then stop, with no side effects at all - useful for sanity-checking the path/UNC-handling logic
on a new machine before doing anything real.

### Alternative: clone natively on Windows

If you'd rather avoid the WSL-mirroring step entirely, clone the repo directly onto a Windows drive
instead of developing through a `\\wsl.localhost\...` checkout:

```powershell
git clone <repo-url> C:\src\windows-eloquent
```

Then run `run-windows.bat` from there. `Start-Eloquent.ps1` detects it's already on a local drive
and bootstraps in place - no mirroring, no `%LOCALAPPDATA%\WindowsEloquent\app` working copy, just
your checkout.

## 1. Install Python 3.10+

`litert-lm` (the pip package) requires Python **3.10 or newer**. Install it with `winget`:

```powershell
winget install -e --id Python.Python.3.12
```

Open a **new** terminal afterwards so `PATH` picks up the install. Confirm with:

```powershell
python --version
```

## 2. Install the `litert-lm` CLI

```powershell
pip install litert-lm
```

This pulls `litert-lm` + `litert-lm-api` (the compiled native engine and its Python bindings) +
`litert-lm-builder` - no compiler, no Bazel, no Visual Studio needed. This is a **prebuilt binary
wheel**, unlike the from-source Bazel recipe in the README/`scratchpad/litert-lm-report.md`, which
you only need if you want to hand-modify the native engine itself.

Confirm the CLI is on `PATH`:

```powershell
litert-lm --version
```

## 3. Import a model

`litert-lm serve` (see step 5) only serves models that have been **registered** via
`litert-lm import` - a plain download or `.litertlm` file sitting on disk isn't enough on its own.
Import gives the model a short **alias**, and that alias (not the HuggingFace repo name, not any
internal app ID) is what goes in the `"model"` field of every request. This app's `ModelManager`
does this import step automatically after every in-app download (see
`src/main/backend/modelManager.ts`), but if you're setting things up by hand or debugging, here's
the equivalent manually:

```powershell
# E2B - smallest, ~2.4 GiB, fastest, least capable
litert-lm import --from-huggingface-repo litert-community/gemma-4-E2B-it-litert-lm gemma-4-E2B-it.litertlm e2b

# E4B - ~3.4 GiB
litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm e4b

# 12B - ~6.1 GiB, most capable - recommended for an RTX 3060 class machine (16GB+ system RAM;
# this all runs on CPU today regardless of the GPU - see the GPU section below - so it's system
# RAM/CPU that gates feasibility, not VRAM)
litert-lm import --from-huggingface-repo litert-community/gemma-4-12B-it-litert-lm gemma-4-12B-it.litertlm 12b
```

All three repos are ungated (Apache-2.0, no HuggingFace account/token needed). Downloads land in
`%USERPROFILE%\.litert-lm\models\<alias>\model.litertlm` by default (overridable via the
`LITERT_LM_DIR` environment variable - the app sets this itself to a sandboxed folder under its own
`userData` directory so it never touches your real `~/.litert-lm`; see `ModelManager.getLitertLmDir()`).

Verify with:

```powershell
litert-lm list
```

which should show your imported alias(es) with their size and import timestamp.

**Recommendation for a 3060 desktop**: start with **12B** if you have 16+ GiB of system RAM to
spare (everything runs on CPU today - see below - so more capable model = more RAM/CPU time, not
more VRAM). Fall back to E4B or E2B if generation feels sluggish; E2B is the one this whole
integration was verified against and is a safe baseline if you just want to confirm everything
works before committing disk/RAM to a bigger model.

## 4. Configure the app (Settings screen)

Open the app's **Settings** tab and set:

- **Backend**: `LiteRT-LM`
- **Model**: pick the one you imported (Gemma 4 E2B / E4B / 12B) and hit Download if it isn't
  already showing "Installed" - the in-app downloader does the same HuggingFace download +
  `litert-lm import` as step 3, so if you already imported by hand, the button will just say
  "Installed" once the app also has its own copy of the `.litertlm` file under its own
  `userData/models/` directory (the app manages its own model file store; it doesn't currently
  read models you imported entirely outside it - use the in-app Download button as the primary
  path, and treat manual `litert-lm import` as a way to sanity-check the CLI itself, not as an
  alternate install method for the app).
- **Sidecar mode**: two options -
  - **Managed** (recommended default): the app spawns `litert-lm serve` itself, using the command
    template field (default: `litert-lm serve --host 127.0.0.1 --port {port}`). Verified: `serve`
    takes **no model-selection flag at all** - it's the same command regardless of which model you
    picked in Settings; model selection happens per-request via the alias (`ModelCatalogEntry.alias`
    in `src/shared/models.ts`), which the app already sends correctly (see
    `BackendController.rebuild()`). Only change this field if your `litert-lm` binary isn't on
    `PATH` (put an absolute path to `litert-lm.exe` instead) or you need non-default flags like
    `--cors-origin`.
  - **External**: point at a `litert-lm serve` instance you started yourself (e.g. in its own
    terminal window with `--verbose` for visible logs while debugging). Useful if you want the
    server logs visible separately from the Electron app, or you're running the server on a
    different machine (see the networking note in step 5).
- **Port**: `9379` is `litert-lm serve`'s real default (this app's defaults were corrected to match
  - an earlier draft used `8765`, which is not a `litert-lm` default and would only have worked by
    coincidence if you also passed `--port 8765` yourself).

## 5. Run in dev (`npm run dev`)

Requires **Node.js >= 20.19.0, or >= 22.12.0** - see "Node.js version requirement" above for why;
`run-windows.bat`/`Start-Eloquent.ps1` check and auto-upgrade this for you, but if you're running
these commands by hand, confirm with `node --version` first.

```powershell
npm install
npm run dev
```

**Run this on the Windows host itself**, not inside WSL2 - two independent reasons:

1. **Microphone access.** The renderer's audio capture (`useAudioCapture.ts`, real
   `getUserMedia`/`AudioWorklet`) needs a real audio input device with OS permission, which WSL2
   doesn't expose the way a native Windows Electron process does.
2. **GPU access for the model.** Even though (see step 6) the current pip build doesn't actually
   route Gemma inference through the GPU today, *if* that changes (a future `litert-lm` release, or
   a differently-exported model), you want the `litert-lm serve` process to be a native Windows
   process with a real path to the RTX 3060's driver stack - not a WSL2 process behind
   WSLg/virtualized GPU passthrough, which adds a layer you don't need once/if GPU inference is
   actually wired up.

Both the Electron app and the `litert-lm serve` sidecar should run as native Windows processes on
the same machine. There's no need to split them across hosts for this hardware profile.

## 6. GPU acceleration - honest findings

**Short version: on the pip-installed `litert-lm serve` command, as of 0.14.0, Gemma-4 inference
runs on CPU only, and there is no CLI flag on `serve` to change that.** This isn't a wheel
limitation - the native engine genuinely has GPU (WebGPU/Dawn/Vulkan) support compiled in and
registers it at every server startup - but two separate things stand between you and using it
through `serve` today:

**Finding 1: `litert-lm serve --help` exposes no backend-selection flag at all.**

```
Usage: litert-lm serve [OPTIONS]
Options:
  --host TEXT         Host to listen on  [default: 0.0.0.0]
  --port INTEGER      Port to listen on  [default: 9379]
  --cors-origin TEXT  Allowed CORS origins...
  --verbose           Enable verbose logging
```

No `--backend`. Reading the installed `litert_lm_cli/commands/serve_util.py`, the server calls
`model.parse_backend(None, model_obj=m)` - i.e. it always **auto-detects** from the model file's
own metadata, never lets you force it via `serve`'s CLI. (`litert-lm benchmark` and `litert-lm run`
*do* expose an explicit `--backend [cpu|gpu|npu]` flag - just not `serve`.)

**Finding 2: the Gemma-4 `.litertlm` exports declare a hardcoded `cpu` backend constraint in their
own metadata**, which is what `serve`'s auto-detect reads. Confirmed directly from a real
`--verbose` server log (`scratchpad/live_server.log`, also reproduced in the earlier
`scratchpad/server.log`):

```
I0000 ... litert_lm_loader.cc:244] section_backend_constraint: cpu
I0000 ... litert_lm_loader.cc:244] section_backend_constraint: cpu
I0000 ... litert_lm_loader.cc:244] section_backend_constraint: cpu
I0000 ... engine_settings.cc:101] The Main backend constraint is not set.
I0000 ... engine_settings.cc:98] The Audio backend constraint is matched: CPU
  MainExecutorSettings: backend: CPU
```

...even though, a few lines later in the same log, the engine still initializes GPU machinery:

```
INFO: [accelerator_registry.cc:54] RegisterAccelerator: ptr=..., name=GPU WebGPU
INFO: [gpu_registry.cc:87] Statically linked GPU accelerator registered.
```

So the binary *can* talk to a GPU (statically-linked WebGPU/Dawn accelerator, present in every
server startup log) - it just never gets asked to for this specific model export, because the
model file itself says "CPU". This was independently confirmed by forcing the issue on
`benchmark` (which *does* let you override):

```powershell
litert-lm benchmark e2b --backend gpu --prefill-tokens 8 --decode-tokens 8
```

On the Linux sandbox this was built in (no real GPU/Vulkan adapter available), this failed with:

```
Warning: Vulkan shaderUniform*ArrayDynamicIndexing required.
 - While initializing adapter (backend=BackendType::Vulkan)
E0000 ... delegate_webgpu.cc:238] Failed to initialize WebGPU environment: INTERNAL: No adapters found
RuntimeError: Failed to create engine for benchmark (model_path=..., backend=gpu)
```

That failure is specifically "no Vulkan adapter found" - not "GPU backend unsupported" or "wrong
wheel." An RTX 3060 with current NVIDIA drivers exposes a real Vulkan 1.3 ICD on Windows, so **it's
plausible `--backend gpu` would actually get further on your machine** than it did in this sandbox.
If you want to check that yourself once you've imported a model:

```powershell
litert-lm benchmark e2b --backend gpu --prefill-tokens 64 --decode-tokens 64
```

If that succeeds and reports meaningfully higher decode tok/s than the CPU numbers below, you've
confirmed your Vulkan driver stack works with the engine - but that still won't change what
`litert-lm serve` does, since (per Finding 1+2) `serve` ignores `--backend` entirely and the
model's own metadata pins it to CPU regardless.

**What this means practically for this app today:**

- Expect **CPU-only** inference through the managed/external sidecar, regardless of GPU hardware,
  for the currently-published `litert-community/gemma-4-*-it-litert-lm` model family.
- Measured CPU performance (16-core Linux sandbox, E2B model, `litert-lm benchmark`): roughly
  **20-25 decode tok/s, 75-200 prefill tok/s**; a real end-to-end transcription of a ~3s WAV took
  ~1.3-2s once the engine was warm. A Windows desktop CPU should be in a similar ballpark; a bigger
  model (E4B/12B) will be proportionally slower.
- **If GPU inference matters to you**, your options, roughly in order of effort:
  1. Wait for/watch for a `litert-community` model export whose metadata doesn't hardcode
     `backend_constraint: cpu` (or for a future `litert-lm` release that adds a `--backend` flag to
     `serve` itself) - check `litert-lm --version` / release notes periodically.
  2. Write a small custom Python entry point using the `litert_lm` package's own API directly
     (`litert_lm.Backend.GPU()`, same call the CLI's `benchmark`/`run` commands use under the hood)
     instead of going through the `serve` subcommand, and point `sidecar.managedCommand` at that
     script instead of the stock `litert-lm serve`. This is real, tractable work (not a rabbit
     hole) since the Python API used to build it is right there in the installed package - but
     it's out of scope for what this integration validated.
  3. For full control (custom accelerator flags, patched engine, etc.), fall back to the Bazel
     from-source Windows build recipe already documented in the README
     (`README.md#building-installing-litert-lm-on-windows`) and in more depth in
     `scratchpad/litert-lm-report.md` - that build target explicitly supports
     `--config=windows` GPU builds (WebGPU/Dawn/D3D12) with the accelerator DLLs `serve`'s prebuilt
     wheel doesn't currently expose a way to select.

## 7. Building a distributable (`npm run build:win`)

```powershell
npm run build
npm run build:win
```

`npm run build` runs `typecheck` then `electron-vite build` (main + preload + renderer);
`npm run build:win` additionally runs `electron-builder --win`, producing an NSIS installer and a
portable `.exe` per `electron-builder.yml`. This step was not run against a real Windows/electron-
builder toolchain as part of this integration (the dev/verification sandbox is Linux) - the config
file itself was written and validated as parseable YAML only. Run it on an actual Windows machine
(or a Windows CI runner) before distributing.

Note that `litert-lm` itself is **not bundled** by `electron-builder` - it's a separate install the
end user (or your own installer script, if you extend `electron-builder.yml`'s `extraResources`)
needs to provide, exactly as described in steps 1-3 above.

## Summary checklist

- [ ] Easiest: double-click `run-windows.bat` and skip straight to the last two items (see
      "Quick start: one-click launcher" above - it mirrors a UNC/WSL checkout to a local working
      copy automatically; skim it before your first run)
- [ ] `winget install -e --id Python.Python.3.12` (or any 3.10+)
- [ ] `winget install -e --id OpenJS.NodeJS.LTS` and confirm `node --version` is >= 20.19.0 (or
      >= 22.12.0) - see "Node.js version requirement" above; `run-windows.bat` does this for you
      automatically, including upgrading an existing too-old Node in place
- [ ] `pip install litert-lm`
- [ ] `litert-lm import --from-huggingface-repo litert-community/gemma-4-12B-it-litert-lm gemma-4-12B-it.litertlm 12b` (or e2b/e4b)
- [ ] App Settings: Backend = LiteRT-LM, Model = the one you imported, Sidecar mode = Managed, Port = 9379
- [ ] `npm run dev` on the Windows host (not WSL2) for real mic + a clean path to GPU if that ever matters
- [ ] Don't expect GPU acceleration from `litert-lm serve` today - see section 6
- [ ] `npm run build && npm run build:win` on a real Windows machine to produce an installer
