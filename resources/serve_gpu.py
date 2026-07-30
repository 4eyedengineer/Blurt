#!/usr/bin/env python
"""Runs `litert-lm serve`, forcing the main LLM engine onto the GPU
(WebGPU/Dawn -> Direct3D 12 on Windows) backend.

## Why this exists

The pip `litert-lm` CLI's `serve` command has no `--backend` flag at all
(confirmed via `litert-lm serve --help` on 0.14.0) - the HTTP server always
resolves the engine's backend from the model file's own
`backend_constraint` metadata. For the `litert-community/gemma-4-*`
`.litertlm` files, every section in that metadata (including the optional
audio/vision adapters) reports `backend_constraint: cpu`, so `serve` always
loads the engine on CPU with no way to override it from the CLI.

Empirically (see `litert-lm benchmark --backend gpu` against the same model
file, and this script's own end-to-end test against a real `litert-lm
serve` process) the *main* prefill/decode graph runs fine on GPU despite
that constraint - `backend_constraint` on this model only actually matters
for the optional audio/vision adapters, which are genuinely CPU-only.
Measured on an RTX 3060 Laptop GPU (6 GB VRAM) against the Gemma-4 E2B
`.litertlm`, warm (disk-cached compiled shaders):

    Backend   Prefill tok/s   Decode tok/s   Init time
    CPU       ~327            ~16            ~8s
    GPU       ~85             ~54            ~8s (~15s cold, before the
                                                    shader cache is warm)

Decode throughput (what dominates perceived latency for anything longer
than a couple words) is ~3.4x faster on GPU. Prefill is slower on GPU in
this configuration, but prefill is already fast in absolute terms, so this
is a clear net win for the dictation/chat workload this app cares about.

## The hook point

`litert_lm_cli.commands.serve_util.get_or_initialize_server_engine` (the
function that lazily builds the `litert_lm.Engine` on the first HTTP
request) resolves the *main* backend via:

    backend = model.parse_backend(None, model_obj=m)

and the vision/audio backends via the same function but with an explicit
`label=` kwarg:

    vision_backend = model.parse_backend(None, model_obj=m, ..., label="vision")
    audio_backend  = model.parse_backend(None, model_obj=m, ..., label="audio")

`parse_backend(backend=None, ...)` falls back to the model's
`backend_constraint` metadata. So: monkeypatching `model.parse_backend` to
force `backend="gpu"` only when called with `backend is None and label is
None` targets exactly the main-model resolution, leaving vision/audio
backend selection (and therefore their real CPU constraint) untouched.

## Fallback

If GPU engine creation actually fails (no compatible adapter - e.g. no
Vulkan ICD on a Linux/WSL box with no `VK_ICD_FILENAMES`, or a GPU too old
for the required WebGPU features - confirmed by reproducing this exact
error in WSL2, which has no Vulkan adapter at all: `litert_lm.Engine.close`
raising `RuntimeError` and the native log showing "Failed to initialize
WebGPU environment: INTERNAL: No adapters found"), the *first* request that
triggers engine creation fails; every later request that resolves to the
same (model_id, backend) tuple would keep failing the same way since
`serve_util` caches the engine keyed on that tuple. This wrapper catches
that first failure, logs a clear marker line to stderr, and flips its own
forced-backend state to "cpu" before retrying the same request-triggered
engine creation - so a machine without a working GPU falls back to CPU
automatically, at the cost of one failed+retried first request, without
requiring the Electron sidecar manager to know anything about backends at
all.

## Effective-backend reporting (don't trust the requested accelerator alone)

Because GPU init can fail and silently fall back to CPU (see "Fallback"
above), anything upstream (the Electron app's Sidecar/BackendController,
see sidecar.ts) that wants to show the user which backend is *actually*
running must not just echo back the requested `accelerator` setting - it
has to observe the truth from here. So as soon as an engine is actually
created (or reused) - success or post-fallback - this script prints an
unambiguous, machine-readable line to stdout:

    ELOQUENT_EFFECTIVE_BACKEND=gpu
    ELOQUENT_EFFECTIVE_BACKEND=cpu

`sidecar.ts` parses this off the child process's stdout and surfaces it as
`BackendStatus.effectiveAccelerator`, all the way to the Settings screen -
see that file and `backendController.ts` for the plumbing.

## Eager engine creation (so the report - and fallback - happen before the
## sidecar looks "ready")

`get_or_initialize_server_engine` (see "The hook point" above) only runs
lazily, on the first HTTP request that needs it - normally that would mean
the effective-backend report (and any GPU->CPU fallback) wouldn't happen
until well after the Electron app already thinks the sidecar is "ready"
(its readiness check is just `GET /v1/models`, which doesn't touch the
engine at all). To avoid ever showing "GPU" while the engine actually
ended up on CPU, this script forces engine creation to happen synchronously
during `LiteRTLMServer.__init__` (monkeypatched below) instead - which runs
*before* `run_server` ever reaches `server.serve_forever()`. Since the
underlying `TCPServer.__init__` already binds and listens on the socket
before returning (it just doesn't `accept()` connections yet), a client
polling for readiness during this window sees connection attempts time out
rather than an error - so it naturally keeps waiting until eager init (and
the effective-backend report) has finished, without any changes needed on
the Electron side's readiness polling.

This needs to know which model to load ahead of any real request - set
`ELOQUENT_EAGER_MODEL_ID` to the exact alias the model was `litert-lm
import`-ed as (see `ModelCatalogEntry.alias` in shared/models.ts; the
Electron app always sets this for a managed GPU sidecar - see
`backendController.ts`). If unset (e.g. running this script by hand),
eager creation is skipped and engine creation falls back to the normal
lazy, first-request path - the effective-backend report still happens
there, just later.

## Usage

Drop-in replacement for `litert-lm serve` in a managed sidecar command
template - same CLI surface (`serve --host ... --port ... --verbose ...`),
via the venv's `python.exe` instead of the `litert-lm.exe` launcher (since
we need to monkeypatch first, and `litert-lm.exe` doesn't give us a code
hook to do that from outside):

    python /path/to/serve_gpu.py serve --host 127.0.0.1 --port {port}

Set LITERT_LM_SERVE_BACKEND=cpu to disable the GPU-forcing behavior
entirely (falls back to this script being a transparent passthrough to the
normal `serve` command) - useful for A/B-testing GPU vs CPU without editing
the managed command template.

Set ELOQUENT_EAGER_MODEL_ID=<alias> to have engine creation (and therefore
the ELOQUENT_EFFECTIVE_BACKEND report) happen eagerly at startup instead of
lazily on the first request - see "Eager engine creation" above.
"""

from __future__ import annotations

import os
import sys

from litert_lm_cli import model as _model

_DEFAULT_TARGET_MODEL_TYPES = _model._DEFAULT_TARGET_MODEL_TYPES  # pylint: disable=protected-access
_orig_parse_backend = _model.parse_backend

# Mutable so the fallback below can flip it after a failed GPU engine
# creation, without needing to re-import/re-patch anything.
_state = {
    "backend": os.environ.get("LITERT_LM_SERVE_BACKEND", "gpu").strip().lower() or "gpu"
}


def _forced_backend_parse_backend(
    backend=None,
    *,
    model_obj=None,
    cpu_thread_count=None,
    target_model_types=_DEFAULT_TARGET_MODEL_TYPES,
    label=None,
):
  """Forces the main-model backend resolution; leaves vision/audio alone.

  Only intercepts the exact call shape `serve_util.get_or_initialize_server_engine`
  uses for the main model (`backend=None`, no `label`). Any explicit
  `backend` (e.g. a future CLI flag) or any labeled call (vision/audio) is
  passed straight through unchanged.
  """
  if backend is None and label is None and _state["backend"] != "cpu":
    backend = _state["backend"]
  return _orig_parse_backend(
      backend,
      model_obj=model_obj,
      cpu_thread_count=cpu_thread_count,
      target_model_types=target_model_types,
      label=label,
  )


_model.parse_backend = _forced_backend_parse_backend

# serve_util imports `model` as `from litert_lm_cli import model` and always
# calls `model.parse_backend(...)` (attribute access at call time), so
# patching the module-level name above is enough - no need to also patch
# serve_util's own namespace.
from litert_lm_cli.commands import serve_util  # noqa: E402  pylint: disable=wrong-import-position

_orig_get_or_initialize_server_engine = serve_util.get_or_initialize_server_engine


def _report_effective_backend() -> None:
  """Prints the ELOQUENT_EFFECTIVE_BACKEND marker line - see this module's
  "Effective-backend reporting" doc comment. Reflects `_state["backend"]`,
  which is only ever "gpu" if that's genuinely what the just-created (or
  reused) engine is running on - the fallback below always flips it to
  "cpu" *before* this is called, if that's what actually happened.
  """
  sys.stdout.write(f"ELOQUENT_EFFECTIVE_BACKEND={_state['backend']}\n")
  sys.stdout.flush()


def _get_or_initialize_server_engine_with_fallback(server, *, model_id):
  try:
    engine = _orig_get_or_initialize_server_engine(server, model_id=model_id)
  except RuntimeError as err:
    if _state["backend"] == "cpu":
      raise  # Already on CPU - nothing left to fall back to.
    sys.stderr.write(
        "[serve_gpu] GPU engine initialization failed "
        f"({err}); falling back to CPU backend for the rest of this "
        "process's lifetime.\n"
    )
    sys.stderr.flush()
    _state["backend"] = "cpu"
    engine = _orig_get_or_initialize_server_engine(server, model_id=model_id)
  _report_effective_backend()
  return engine


serve_util.get_or_initialize_server_engine = _get_or_initialize_server_engine_with_fallback

_EAGER_MODEL_ID_ENV = "ELOQUENT_EAGER_MODEL_ID"
_orig_server_init = serve_util.LiteRTLMServer.__init__


def _server_init_with_eager_engine(self, *args, **kwargs):
  """Wraps `LiteRTLMServer.__init__` to create the main-model engine
  synchronously, before this constructor (and therefore `run_server`'s
  `with LiteRTLMServer(...) as server:` block) returns - see "Eager engine
  creation" above for why. Best-effort: if `ELOQUENT_EAGER_MODEL_ID` isn't
  set, or engine creation fails for any reason, logs to stderr and leaves
  engine creation to the normal lazy first-request path rather than
  crashing the server.
  """
  _orig_server_init(self, *args, **kwargs)
  model_id = os.environ.get(_EAGER_MODEL_ID_ENV, "").strip()
  if not model_id:
    return
  try:
    _get_or_initialize_server_engine_with_fallback(self, model_id=model_id)
  except Exception as err:  # pylint: disable=broad-exception-caught
    sys.stderr.write(
        f"[serve_gpu] Eager engine init for model '{model_id}' failed "
        f"({err}); will retry lazily on the first real request.\n"
    )
    sys.stderr.flush()


serve_util.LiteRTLMServer.__init__ = _server_init_with_eager_engine

if __name__ == "__main__":
  from litert_lm_cli import main as _cli_main

  _cli_main.main()
