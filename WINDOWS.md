# Running Blurt from source on Windows

This is the practical guide for building and running Blurt from source on a Windows host, plus a
deep dive into how its GPU acceleration works. If you just want to _use_ Blurt, you don't need any
of this. See the main [README.md](README.md) for the installer download.

This assumes you've read [CONTRIBUTING.md](CONTRIBUTING.md)'s "The real backend: LiteRT-LM"
section for the wire-protocol/architecture background; this doc is the Windows-specific how-to.

Everything below was verified against a real `litert-lm` 0.14.0 pip install. GPU execution
specifically was verified against a real discrete NVIDIA GPU. See "GPU acceleration" below for the
exact commands/log lines and measured tokens/s.

## 1. Install Python 3.10+

`litert-lm` (the pip package) requires Python **3.10 or newer**. Install it with `winget`:

```powershell
winget install -e --id Python.Python.3.12
```

Open a **new** terminal afterwards so `PATH` picks up the install. Confirm with:

```powershell
python --version
```

## 2. Install Node.js

Blurt needs **Node.js >= 20.19.0, or >= 22.12.0**. That's Vite's own `engines` requirement
(`node_modules/vite/package.json` once installed), and it's a hard requirement, not a soft
recommendation: Vite's config loader calls the Node built-in `crypto.hash()`, which was added in
Node 21.7.0 and backported to 20.12.0. Anything in the 20.12-20.18 or 21.0-21.6 ranges either lacks
`crypto.hash()` entirely or fails Vite's own engines check, and `npm run dev` dies immediately with:

```
TypeError: crypto.hash is not a function
    at getHash (.../node_modules/vite/dist/node/chunks/config.js:...)
```

```powershell
winget install -e --id OpenJS.NodeJS.LTS
node --version
```

## 3. Install the `litert-lm` CLI

```powershell
pip install litert-lm
```

This pulls `litert-lm` + `litert-lm-api` (the compiled native engine and its Python bindings) +
`litert-lm-builder`. No compiler, no Bazel, no Visual Studio needed. This is a prebuilt binary
wheel, unlike the from-source Bazel recipe in "Building `litert-lm` from source" below, which you
only need if you want to hand-modify the native engine itself.

Confirm the CLI is on `PATH`:

```powershell
litert-lm --version
```

## 4. Import a model

`litert-lm serve` only serves models that have been **registered** via `litert-lm import`. A
plain download or `.litertlm` file sitting on disk isn't enough on its own. Import gives the model
a short **alias**, and that alias (not the HuggingFace repo name, not any internal app ID) is what
goes in the `"model"` field of every request. Blurt's `ModelManager` does this automatically after
every in-app download (`src/main/backend/modelManager.ts`), but if you're setting things up by hand
or debugging, here's the equivalent manually:

```powershell
# E2B - smallest, ~2.4 GiB, fastest, least capable
litert-lm import --from-huggingface-repo litert-community/gemma-4-E2B-it-litert-lm gemma-4-E2B-it.litertlm e2b

# E4B - ~3.4 GiB
litert-lm import --from-huggingface-repo litert-community/gemma-4-E4B-it-litert-lm gemma-4-E4B-it.litertlm e4b

# 12B - ~6.1 GiB, most capable
litert-lm import --from-huggingface-repo litert-community/gemma-4-12B-it-litert-lm gemma-4-12B-it.litertlm 12b
```

All three repos are ungated (Apache-2.0, no HuggingFace account/token needed). Downloads land in
`%USERPROFILE%\.litert-lm\models\<alias>\model.litertlm` by default (overridable via the
`LITERT_LM_DIR` environment variable; the app sets this itself to a sandboxed folder under its own
`userData` directory so it never touches your real `~/.litert-lm`; see
`ModelManager.getLitertLmDir()`).

Verify with:

```powershell
litert-lm list
```

which should show your imported alias(es) with their size and import timestamp.

**Recommendation**: start with **E2B** to confirm everything works before committing disk/RAM to a
bigger model. E4B and 12B are more capable but slower, and everything runs through the same GPU/CPU
path described below regardless of which one you pick.

## 5. Run in dev (`npm run dev`)

```powershell
git clone <repo-url> C:\src\blurt
cd C:\src\blurt
npm install
npm run dev
```

**Run this on the Windows host itself**, not inside WSL2, for two independent reasons:

1. **Microphone access.** The renderer's audio capture (`useAudioCapture.ts`, real
   `getUserMedia`/`AudioWorklet`) needs a real audio input device with OS permission, which WSL2
   doesn't expose the way a native Windows Electron process does.
2. **GPU access for the model.** See "GPU acceleration" below. It needs a native Windows process
   with a direct path to your GPU's driver stack. A WSL2 process sits behind virtualized GPU
   passthrough with no real Vulkan ICD in the common case, so the sidecar falls back to CPU via its
   own fallback logic instead of actually using the GPU. The app knows and shows this truthfully
   (Settings reads "Running on CPU", status pill reads "Ready · CPU") rather than displaying
   anything it hasn't observed.

Both the Electron app and the `litert-lm serve` sidecar run as native Windows processes on the same
machine. There's no need to split them across hosts.

Once the window opens, open **Settings**, pick a model, and hit Download if it isn't already
"Installed" (the in-app downloader does the same HuggingFace download + `litert-lm import` as
step 4; if you already imported by hand, use the in-app Download button anyway, since the app
manages its own model file store under its own `userData/models/` directory and doesn't currently
read models imported entirely outside it).

The default sidecar command runs `resources/serve_gpu.py` through the venv Python that
`npm run dev` bootstraps for a packaged build (see "GPU acceleration" below), on port `9379`,
matching `litert-lm serve`'s own default. There's nothing to configure for GPU vs. CPU; it's
decided automatically per machine.

## 6. GPU acceleration: how it works and what was measured

**Short version: GPU acceleration is automatic. It was verified end-to-end against a real discrete
NVIDIA GPU with 6 GB of VRAM, and decode throughput is ~3.4x faster than CPU once warm.** Getting
there needed a small wrapper script, because the pip `serve` CLI itself has no way to select a
backend. The two findings below explain why, and are still accurate as of `litert-lm` 0.14.0.

### Supported hardware (this is not NVIDIA/RTX-specific)

GPU acceleration goes through **Dawn (WebGPU)**, whose Windows backend is **Direct3D 12**. Any
DX12-capable GPU is a supported adapter (NVIDIA, AMD, or Intel; discrete or integrated). Nothing in
Blurt or `resources/serve_gpu.py` filters, checks, or branches on a vendor/adapter name. The
GPU numbers throughout this doc (from a 6 GB discrete NVIDIA card) are one _measured example_,
not a requirement. Dawn logs
whichever adapter it actually picked: `Selected adapter: <name>, vendor=<vendor>, backend=Direct3D
12, adapterType=<Discrete|Integrated> GPU`. `<name>`/`<vendor>` come from your driver, never from
this codebase.

**Multi-GPU (hybrid graphics) laptops**: adapter selection is entirely delegated to Dawn/D3D12:
neither `litert-lm`'s Python API nor `serve_gpu.py` expose a way to force a specific physical GPU.
Confirmed on a machine with both an NVIDIA dGPU and an Intel iGPU: Dawn's default picked the
discrete GPU with zero configuration. If a different machine's default enumeration ever prefers the
integrated GPU instead, there is currently no supported knob to override that.

**Minimum VRAM**: budget **at least 4 GB of VRAM for E2B/E4B on GPU**, derived from this model's
measured GPU-resident footprint (~3.9 GB warm). A 6 GB card (the example used throughout this doc)
has comfortable headroom. The 12B model was only ever verified on CPU. Don't
expect it to fit on a 6 GB-class GPU.

**Unsupported hardware**: no compatible DX12 adapter (or a GPU below Dawn's required feature level)
means the wrapper's own fallback (see "Fallback if GPU init fails" below) catches the failed engine
creation and retries on CPU for the rest of that process's lifetime. This is reported truthfully as
"CPU (GPU unavailable)", never a silent/wrong "GPU" claim.

**Verify what's actually running, vendor-neutral**:

- NVIDIA: `nvidia-smi` (see "Verifying GPU" below)
- AMD/Intel: Task Manager -> Performance -> GPU (or the GPU column on the Processes tab)

Same idea either way, no NVIDIA-specific tool required.

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
calls `model.parse_backend(None, model_obj=m)` for the main model. That is, it auto-detects from
the model file's own metadata and never lets you force it via `serve`'s CLI. (`litert-lm benchmark`
and `litert-lm run` _do_ expose an explicit `--backend [cpu|gpu|npu]` flag, just not `serve`.)

**Finding 2: the Gemma-4 `.litertlm` exports declare a hardcoded `cpu` backend constraint in their
own metadata for every section** (including the optional audio/vision adapters), which is what
`serve`'s auto-detect reads:

```
I0000 ... litert_lm_loader.cc:244] section_backend_constraint: cpu   (repeated per section)
```

**But that constraint does not actually block GPU execution of the main model.** It turns out to
matter only for the audio/vision adapters, which genuinely are CPU-only. Forcing `--backend gpu` on
`litert-lm benchmark` against the _same_ `cpu`-constrained E2B file, on a real discrete NVIDIA GPU,
the engine happily initializes GPU and runs real inference:

```
I0000 ... environment.cc:522] Selected adapter: <name>,
arch=<arch>, vendor=<vendor>, backend=Direct3D 12, adapterType=Discrete GPU
I0000 ... engine_settings.cc:101] The Main backend constraint is not set.
I0000 ... engine_settings.cc:98] The Audio backend constraint is matched: CPU
  MainExecutorSettings: backend: GPU
```

(`<name>`/`<arch>`/`<vendor>` come from your driver, same as elsewhere in this doc; on the machine
this was measured on, `vendor` read `nvidia`.)

**Measured tokens/s** (`litert-lm benchmark`, Gemma 4 E2B, a 6 GB discrete NVIDIA GPU, 128 prefill /
64 decode tokens, `--cache disk` default):

| Backend                         | Prefill tok/s | Decode tok/s | Init time                         |
| ------------------------------- | ------------- | ------------ | --------------------------------- |
| CPU                             | ~327          | ~16          | ~8s                               |
| GPU (cold, first run)           | ~49           | ~46          | ~15.5s (compiling WebGPU shaders) |
| GPU (warm, disk-cached shaders) | ~85           | ~54          | ~7.8s                             |

Decode throughput, which dominates perceived latency for anything longer than a couple words, is
**~3.4x faster on GPU once warm** (~54 vs ~16 tok/s). Prefill is actually _slower_ on GPU in this
configuration; that's fine for a dictation/chat workload where prefill is already fast in absolute
terms and decode length is what you feel. The first run after enabling GPU pays a one-time ~15s
shader-compile cost (`--cache disk`, the default, persists the compiled shaders next to the model
file so every run after the first is warm).

**How Blurt gets GPU without a `litert-lm serve --backend` flag:** `resources/serve_gpu.py` is a
thin wrapper (see its own doc comment for the full mechanism) that monkeypatches
`litert_lm_cli.commands.serve_util`'s backend-resolution function so the _main_ model is forced onto
GPU while the audio/vision adapters are left on their own (correctly CPU-constrained) default. This
was verified end-to-end against a real `litert-lm serve` process spawned this way, hitting
`/v1/chat/completions` and getting back a real completion with `MainExecutorSettings: backend: GPU`
and the `Selected adapter: ... Direct3D 12` line in the log. The managed sidecar always points at
this wrapper; there is no separate CPU-only command to opt into.

**Fallback if GPU init fails**: the wrapper catches a failed GPU engine-creation and retries the
same request on CPU, logging a `[serve_gpu] GPU engine initialization failed (...); falling back to
CPU backend` line, then stays on CPU for the rest of that sidecar process's lifetime. If the
sidecar process dies before ever reporting ready at all (a harder failure than a single request
falling back), the app's own `Sidecar` retries the whole process once more with CPU forced via
`LITERT_LM_SERVE_BACKEND=cpu`, so a machine without a working GPU still ends up running rather than
stuck in an error state. Crucially, none of this fallback is silent to the user: the wrapper eagerly
creates the engine at process startup (before the sidecar looks "ready" to the Electron app) and
prints an unambiguous `BLURT_EFFECTIVE_BACKEND=gpu`/`=cpu` marker line to stdout as soon as it
knows which backend it actually got. The app parses that marker, and the Settings readout / status
pill reflect the real backend, not just the one it hoped for.

**If you want to re-verify any of this yourself** once you've imported a model:

```powershell
litert-lm benchmark e2b --backend gpu --prefill-tokens 128 --decode-tokens 64 --verbose
litert-lm benchmark e2b --backend cpu --prefill-tokens 128 --decode-tokens 64 --verbose
```

Look for `Selected adapter: ... backend=Direct3D 12` in the GPU run's log and compare the two
`----- Results -----` blocks' decode tok/s.

**For full control** (custom accelerator flags, a patched engine, bundling a Python-free sidecar),
see "Building `litert-lm` from source" below. That's not needed for GPU acceleration itself (the
wrapper above covers that); it's only for going beyond what the pip wheel + wrapper combination
exposes.

### Verifying GPU: "is it actually on?"

The Settings readout and status pill tell the truth, but here's how to double-check yourself in
under a minute:

- **Status pill** (top of the app window): `Ready · GPU` once the sidecar's engine has actually
  confirmed it: not just "Ready" alone, and not `Ready · CPU` (that means it fell back).
- **main.log** (Settings > "Open logs folder"): grep for `effective-backend=gpu`: the line looks
  like `sidecar: effective-backend=gpu`. If you instead see `Port 9379 is already in use by another
process (PID ...)`, some other process (commonly a stale sidecar left running from a previous app
  session that didn't shut down cleanly; see `src/main/backend/portGuard.ts`) is squatting on the
  port; the message names its PID so you can `taskkill /PID <pid> /F` it, then relaunch.
- **Task Manager** -> Performance -> GPU (or the GPU column on the Processes tab): a `python.exe`
  process should be visible with non-trivial VRAM usage (roughly 2-3 GiB for the E2B model) and its
  GPU-Util spikes while you're actively dictating/generating, not before, since the engine only
  runs inference on request.
- **One-liner from PowerShell**:

  ```powershell
  nvidia-smi
  ```

  Look for a `python.exe` row under "Processes" with nonzero GPU memory, and `GPU-Util` ticking up
  while a request is in flight. No `python.exe` row at all (only browser/desktop processes) means
  nothing is currently using the GPU: either the sidecar isn't running, or it's on CPU.

### Crash-safe cleanup

A normal app quit already kills the sidecar (`child.kill()`/Windows `TerminateProcess` terminates a
`python.exe` child spawned this way, releasing its VRAM immediately). A **hard crash or kill** of
the Electron process (Task Manager, `taskkill /f`, power loss) is also covered: `serve_gpu.py` runs
a parent-watchdog thread (`BLURT_PARENT_PID`, set automatically by `sidecar.ts`) that notices the
moment the Electron process dies and exits itself immediately, releasing the GPU/CPU engine's
memory. No orphaned model process is left running until your next launch.

## 7. Building a distributable (`npm run build:win`)

```powershell
npm run build
npm run build:win
```

`npm run build` runs `typecheck` then `electron-vite build` (main + preload + renderer);
`npm run build:win` additionally runs `electron-builder --win`, producing an NSIS installer per `electron-builder.yml`.

Must be run on a real Windows machine (or a Windows CI runner): electron-builder needs the Windows
toolchain to produce these. `electron-builder install-app-deps` will fail to rebuild `uiohook-napi`
(the push-to-talk key hook) unless Visual Studio Build Tools are installed; that failure is safe to
ignore, because the package ships a prebuilt N-API binary which loads correctly at runtime. The
installer is not code-signed, so a fresh install triggers a Windows SmartScreen warning. See the
README's Troubleshooting section for what to click through.

This has been run on a real Windows host and the resulting installer was verified
end to end: boot to a ready backend on GPU, a second launch refused by the single-instance lock,
and a clean shutdown with no orphaned sidecar process.

Note that `litert-lm` itself is **not bundled** by `electron-builder`; it's a separate install the
end user's copy of Blurt sets up for itself on first launch (see
`src/main/runtime/firstRunSetup.ts`), or that you provide yourself when developing, exactly as
described in steps 1-4 above.

## Building `litert-lm` from source

Not needed for GPU acceleration itself (the pip wheel + `serve_gpu.py` wrapper above covers that).
It's only useful if you need custom accelerator flags or a patched engine. A documented from-source
Windows build recipe exists upstream (see
[google-ai-edge/LiteRT-LM](https://github.com/google-ai-edge/LiteRT-LM),
`docs/getting-started/build-and-run.md`): Visual Studio 2022 ("Desktop development with C++"),
Bazel via Bazelisk, Git for Windows (its bundled `bash.exe` is required, since some build steps
shell out to it), Python 3.13, a JDK, and enabling NTFS long paths (`LongPathsEnabled` registry key,
since Bazel's output tree nests deep). CPU builds are
`bazelisk build //runtime/engine:litert_lm_main --config=windows`; GPU (WebGPU/Dawn/D3D12) builds
additionally need `--define=litert_runtime_link_mode=dynamic
--define=resolve_symbols_in_exec=false` and require copying the prebuilt accelerator DLLs
(`prebuilt/windows_x86_64/*.dll`) plus Dawn's `dxcompiler.dll`/`dxil.dll` (fetched hermetically by
Bazel from Microsoft's DirectXShaderCompiler releases) into the same directory as the built binary.
A hand-built binary doesn't get these copied automatically the way the upstream Python-wheel build
target does.

## Summary checklist

- [ ] `winget install -e --id Python.Python.3.12` (or any 3.10+)
- [ ] `winget install -e --id OpenJS.NodeJS.LTS` and confirm `node --version` is >= 20.19.0 (or >= 22.12.0)
- [ ] `pip install litert-lm`
- [ ] `litert-lm import --from-huggingface-repo litert-community/gemma-4-E2B-it-litert-lm gemma-4-E2B-it.litertlm e2b` (or e4b/12b)
- [ ] `npm install && npm run dev`, then in Settings pick a model and hit Download
- [ ] GPU acceleration is automatic (~3.4x faster decode, measured on a discrete NVIDIA GPU; see
      section 6); drops to CPU on its own if GPU init fails, and Settings/the status pill say so
      truthfully if it does
- [ ] Model/VRAM is cleaned up on quit _and_ on a hard crash; see "Crash-safe cleanup" above
- [ ] `npm run build && npm run build:win` on a real Windows machine to produce an installer
