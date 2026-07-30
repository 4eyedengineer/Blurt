# Running Windows Eloquent on Windows (RTX 3060)

This is the practical setup guide for running the real LiteRT-LM backend on a Windows host, as
opposed to the Linux/WSL2 dev/test loop. It assumes you've already read the
"[The real backend: LiteRT-LM](README.md#the-real-backend-litert-lm)" section of the README - this
doc is the Windows-specific how-to; the README has the wire-protocol/architecture background.

Everything below was verified empirically against a real `litert-lm` 0.14.0 pip install (see
`scripts/integration-live.mjs` and `scratchpad/sidecar-verification.md` for the raw evidence) - not
guessed from documentation. GPU execution specifically was verified against a real RTX 3060 Laptop
GPU (via WSL interop into the actual Windows host this app targets, not just theorized about) - see
"GPU acceleration" below for the exact commands/log lines and measured tokens/s.

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
  - **Managed** (recommended default): the app spawns a sidecar process itself, using the command
    template field. `serve` takes **no model-selection flag at all** - it's the same command
    regardless of which model you picked in Settings; model selection happens per-request via the
    alias (`ModelCatalogEntry.alias` in `src/shared/models.ts`), which the app already sends
    correctly (see `BackendController.rebuild()`). Only change this field if your `litert-lm`
    binary/Python venv isn't on `PATH` (put an absolute path instead) or you need non-default flags
    like `--cors-origin`.
  - **GPU acceleration toggle** (Settings, right above this field): on by default for a fresh
    install (see "GPU acceleration" below) - it swaps the command
    template to `python "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose`, i.e. the
    same `litert-lm serve` but launched through `resources/serve_gpu.py`, a small wrapper that
    forces the model onto GPU (the real `serve` CLI has no flag to do this itself - see below for
    why). Turning it off reverts to the plain `litert-lm serve --host 127.0.0.1 --port {port}`
    template. The toggle's own label always tells the truth about what's actually running - if GPU
    was requested but the sidecar's engine fell back to CPU, it reads "CPU (GPU unavailable)"
    instead of just staying on "GPU" (see `BackendStatus.effectiveAccelerator`).

    **Important**: that bare `python` in the template above is only safe if this venv's `Scripts`
    directory is genuinely first on `PATH` when the app runs. `Start-Eloquent.ps1` seeds a fresh
    `settings.json` with this venv's **absolute** `python.exe` path instead of bare `python`
    specifically to avoid that assumption (a real bug: PATH order picked a system-wide Python
    install instead of this venv, and the model-import step failed against it). If you flip this
    toggle by hand (or hand-edit the command field) back to bare `python`, the sidecar itself may
    still start fine via PATH, but the app's import-CLI resolver
    (`resolveImportCli` in `src/main/backend/sidecar.ts`) will refuse to guess and hard-errors
    with a clear message the next time it needs to `litert-lm import` a model - point the command
    at this venv's absolute `python.exe` (`%LOCALAPPDATA%\WindowsEloquent\venv\Scripts\python.exe`)
    to fix it.
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
2. **GPU access for the model.** See step 6 - GPU acceleration (WebGPU/Direct3D 12) is real and on
   by default, but it needs a native Windows process with a direct path to the RTX 3060's driver
   stack. A WSL2 process sits behind WSLg/virtualized GPU passthrough (no real Vulkan ICD in that
   sandbox as of this writing - confirmed empirically, see step 6), so running the sidecar there
   falls back to CPU via the wrapper's own fallback logic instead of actually using the GPU - and,
   unlike before, the app now knows and shows this truthfully (Settings toggle reads "CPU (GPU
   unavailable)", status pill reads "Ready · CPU") rather than just displaying the requested setting.

Both the Electron app and the `litert-lm serve` sidecar should run as native Windows processes on
the same machine. There's no need to split them across hosts for this hardware profile.

## 6. GPU acceleration - how it works and what was measured

**Short version: GPU acceleration is on by default for a fresh install - and was verified end-to-end
against a real RTX 3060 Laptop GPU
(6 GB VRAM) - decode throughput is ~3.4x faster than CPU once warm.** Getting there needed a small
wrapper script, because the pip `serve` CLI itself has no way to select a backend - the two findings
below explain why, and are still accurate as of `litert-lm` 0.14.0.

**Finding 1: `litert-lm serve --help` exposes no backend-selection flag at all.**

```
Usage: litert-lm serve [OPTIONS]
Options:
  --host TEXT         Host to listen on  [default: 0.0.0.0]
  --port INTEGER      Port to listen on  [default: 9379]
  --cors-origin TEXT  Allowed CORS origins...
  --verbose           Enable verbose logging
```

No `--backend`. Reading the installed `litert_lm_cli/commands/serve_util.py`, the server always
calls `model.parse_backend(None, model_obj=m)` for the main model - i.e. it auto-detects from the
model file's own metadata and never lets you force it via `serve`'s CLI. (`litert-lm benchmark` and
`litert-lm run` *do* expose an explicit `--backend [cpu|gpu|npu]` flag - just not `serve`.)

**Finding 2: the Gemma-4 `.litertlm` exports declare a hardcoded `cpu` backend constraint in their
own metadata for every section** (including the optional audio/vision adapters), which is what
`serve`'s auto-detect reads:

```
I0000 ... litert_lm_loader.cc:244] section_backend_constraint: cpu   (repeated per section)
```

**But that constraint does not actually block GPU execution of the main model** - it turns out only
to matter for the audio/vision adapters, which genuinely are CPU-only. Forcing `--backend gpu` on
`litert-lm benchmark` against the *same* `cpu`-constrained E2B file, on the real RTX 3060 Laptop GPU
(via WSL interop into the actual Windows host, not simulated), the engine happily initializes GPU
and runs real inference:

```
I0000 ... environment.cc:522] Selected adapter: NVIDIA GeForce RTX 3060 Laptop GPU,
arch=ampere, vendor=nvidia, backend=Direct3D 12, adapterType=Discrete GPU
I0000 ... engine_settings.cc:101] The Main backend constraint is not set.
I0000 ... engine_settings.cc:98] The Audio backend constraint is matched: CPU
  MainExecutorSettings: backend: GPU
```

(In WSL2 itself - no Vulkan ICD available at all - the identical command fails with `Failed to
initialize WebGPU environment: INTERNAL: No adapters found`; that's an environment limitation, not
evidence the backend is unsupported. On the actual Windows host it selects the real GPU via
Direct3D 12, as shown above.)

**Measured tokens/s** (`litert-lm benchmark`, Gemma 4 E2B, RTX 3060 Laptop GPU, 128 prefill / 64
decode tokens, `--cache disk` default):

| Backend | Prefill tok/s | Decode tok/s | Init time |
|---|---|---|---|
| CPU | ~327 | ~16 | ~8s |
| GPU (cold, first run) | ~49 | ~46 | ~15.5s (compiling WebGPU shaders) |
| GPU (warm, disk-cached shaders) | ~85 | ~54 | ~7.8s |

Decode throughput - what dominates perceived latency for anything longer than a couple words - is
**~3.4x faster on GPU once warm** (~54 vs ~16 tok/s). Prefill is actually *slower* on GPU in this
configuration; that's fine for a dictation/chat workload where prefill is already fast in absolute
terms and decode length is what you feel. The first run after enabling GPU pays a one-time ~15s
shader-compile cost (`--cache disk`, the default, persists the compiled shaders next to the model
file so every run after the first is warm).

**How this app gets GPU without a `litert-lm serve --backend` flag:** `resources/serve_gpu.py` is
a thin wrapper (see its own doc comment for the full mechanism) that monkeypatches
`litert_lm_cli.commands.serve_util`'s backend-resolution function so the *main* model is forced
onto GPU while the audio/vision adapters are left on their own (correctly CPU-constrained) default
- verified end-to-end against a real `litert-lm serve` process spawned this way, hitting
`/v1/chat/completions` and getting back a real completion with `MainExecutorSettings: backend: GPU`
and the `Selected adapter: ... Direct3D 12` line in the log. The Settings screen's accelerator
toggle (see step 4 above) points the managed sidecar command at this wrapper instead of the bare
`litert-lm serve`; both `Start-Eloquent.ps1` and `DEFAULT_SETTINGS` (see `src/shared/types.ts`)
enable it by default for any fresh install. There's no settings migration for pre-existing installs
- run `uninstall.sh` / `uninstall-windows.bat` for a clean slate if you set one up before this was
the default.

**Fallback if GPU init fails**: the wrapper catches a failed GPU engine-creation (verified in WSL2,
which has no Vulkan adapter - see the log excerpt above) and retries the same request on CPU,
logging a `[serve_gpu] GPU engine initialization failed (...); falling back to CPU backend` line,
then stays on CPU for the rest of that sidecar process's lifetime. So enabling GPU is safe even on
a machine that turns out not to support it - worst case, the very first request after startup pays
both the failed-GPU-attempt cost and a CPU cold-start, and everything after that behaves exactly
like CPU mode. Crucially, this fallback is never silent to the user: the wrapper eagerly creates the
engine at process startup (before the sidecar looks "ready" to the Electron app) and prints an
unambiguous `ELOQUENT_EFFECTIVE_BACKEND=gpu`/`=cpu` marker line to stdout as soon as it knows which
backend it actually got - `sidecar.ts` parses that marker and the Settings toggle / status pill
reflect the real backend, not just the requested one (see `BackendStatus.effectiveAccelerator`
and `resources/serve_gpu.py`'s "Effective-backend reporting"/"Eager engine creation" doc comments).

**If you want to re-verify any of this yourself** once you've imported a model:

```powershell
litert-lm benchmark e2b --backend gpu --prefill-tokens 128 --decode-tokens 64 --verbose
litert-lm benchmark e2b --backend cpu --prefill-tokens 128 --decode-tokens 64 --verbose
```

Look for `Selected adapter: ... backend=Direct3D 12` in the GPU run's log and compare the two
`----- Results -----` blocks' decode tok/s.

**For full control** (custom accelerator flags, a patched engine, bundling a Python-free sidecar),
the Bazel from-source Windows build recipe is documented in the README
(`README.md#building-installing-litert-lm-on-windows`) and in more depth in
`scratchpad/litert-lm-report.md` - not needed for GPU acceleration itself (the wrapper above covers
that), only for going beyond what the pip wheel + wrapper combination exposes.

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
- [ ] `npm run dev` on the Windows host (not WSL2) for real mic access and real GPU acceleration
- [ ] GPU acceleration is on by default for a fresh install (~3.4x faster decode, measured on an
      RTX 3060 Laptop GPU - see section 6); falls back to CPU on its own if GPU init fails, and the
      Settings toggle/status pill say so truthfully if it
      does
- [ ] `npm run build && npm run build:win` on a real Windows machine to produce an installer
