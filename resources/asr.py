#!/usr/bin/env python
"""Speech recognition for Blurt, on the GPU, using NVIDIA Parakeet via ONNX
Runtime instead of routing audio through the multimodal LLM.

## Why this exists

Blurt used to transcribe by handing a WAV to Gemma 4 E2B - a 2.5 GB
multimodal chat model - and asking it to write down what it heard. That
works, but it is the wrong tool: a language model asked to transcribe will
finish a sentence it only half heard. Measured verbatim, E2B turned "similes
drawn from eating" into "his drawn from eating" - fluent, confident, and not
what was said. A recogniser's errors are words it genuinely could not make
out, which read as mistakes rather than as things you said.

Measured on this project against 25 LibriSpeech clips (463 reference words),
on one Windows machine with an RTX 3060, same audio and same scorer
throughout:

    Engine                          WER    median   29s clip   hardware
    parakeet-tdt-0.6b (this file)  1.94%    328ms      359ms   GPU (DirectML)
    whisper-acft small.en          3.46%   3716ms    20561ms   CPU
    whisper-acft base.en           6.26%   1301ms     5229ms   CPU
    Gemma 4 E2B                    6.48%    948ms     3543ms   GPU
    whisper-acft tiny.en          10.37%    748ms          -   CPU

Parakeet is both the most accurate and by a wide margin the fastest, which
is unusual enough to be worth stating plainly: it wins because it is the
only recogniser here that actually reaches the GPU.

Getting there took two dead ends worth recording, so nobody repeats them.
The whisper `.tflite` builds cannot use the GPU through `ai-edge-litert`: its
WebGPU delegate fails to create a device at all unless the DirectX shader
compiler (`dxil.dll`, `dxcompiler.dll`, which `litert_lm` bundles and
`ai_edge_litert` does not) is on the search path, and once that is fixed it
selects the adapter correctly and then hard-crashes the process compiling the
model's kernels - identically for float and quantized builds. That is an
upstream bug, not a configuration problem.

## Hardware

ONNX Runtime picks the first provider in the list it can actually use, so
the accelerated one goes first and CPU is always last. A machine with no
usable GPU therefore still works, and not badly: CPU-only measured 1906ms on
a 29s clip, still faster than either whisper build and faster than Gemma on
its GPU.

Which provider actually got used is logged, never assumed - the same rule the
rest of Blurt follows for the LLM's accelerator (see
`BackendStatus.effectiveAccelerator`).

## What Gemma still does

Everything downstream of the words: cleanup, transforms and voice edit. Only
transcription moves. This is the split Google's own Eloquent app uses - a
small speech expert feeding a Gemma that does the language work.

## Threading

The HTTP server this is mounted in is threaded, and an ONNX Runtime session
is not safe to run concurrently from multiple threads. Every call goes
through `_LOCK`, so overlapping requests queue rather than corrupting each
other. Requests are short (~330ms) and the partial-tick scheduler on the
Electron side already drops overlapping ticks, so queueing costs nothing in
practice.
"""

from __future__ import annotations

import io
import sys
import threading
import wave

import numpy as np

SAMPLE_RATE = 16000

#: The onnx-asr model *type* for Parakeet TDT, used when loading from a local
#: directory rather than by its HuggingFace name (Blurt downloads the files
#: itself - see RecognizerManager - so nothing here reaches the network).
MODEL_TYPE = "nemo-conformer-tdt"
#: Which weight files to load from that directory. The repo also ships fp32
#: weights (a 2.4 GB `.onnx.data`); int8 is what Blurt downloads and the
#: figures above were measured on.
QUANTIZATION = "int8"

_LOCK = threading.Lock()
_STATE: dict[str, object] = {"model": None}


def _providers() -> list[str]:
  """Accelerated provider first, CPU last, so ONNX Runtime falls back on its
  own rather than this code guessing what the machine has.

  DirectML on Windows because it works on any Direct3D 12 GPU regardless of
  vendor - no CUDA dependency, which would be several hundred MB and NVIDIA
  only. CoreML on macOS. Anything else gets CPU, which is fast enough to be a
  real option rather than a token fallback.
  """
  if sys.platform == "win32":
    return ["DmlExecutionProvider", "CPUExecutionProvider"]
  if sys.platform == "darwin":
    return ["CoreMLExecutionProvider", "CPUExecutionProvider"]
  return ["CPUExecutionProvider"]


def decode_wav(data: bytes) -> np.ndarray:
  """PCM16 WAV bytes -> mono float32 in [-1, 1] at SAMPLE_RATE.

  Deliberately strict: Blurt always sends 16 kHz mono PCM16 (see
  pcm16ToWavBase64 in litertBackend.ts), so anything else is a bug worth a
  loud error rather than a silent resample that quietly degrades accuracy.
  """
  with wave.open(io.BytesIO(data), "rb") as wav:
    if wav.getsampwidth() != 2:
      raise ValueError(f"expected 16-bit PCM, got {wav.getsampwidth() * 8}-bit")
    if wav.getframerate() != SAMPLE_RATE:
      raise ValueError(f"expected {SAMPLE_RATE} Hz, got {wav.getframerate()} Hz")
    channels = wav.getnchannels()
    raw = wav.readframes(wav.getnframes())
  samples = np.frombuffer(raw, dtype="<i2").astype(np.float32) / 32768.0
  if channels > 1:
    samples = samples.reshape(-1, channels).mean(axis=1)
  return samples


def load(model_dir: str):
  """Loads the recogniser from a directory of already-downloaded files.

  Reports the provider ONNX Runtime actually selected, rather than the one
  that was requested - those differ exactly when a machine cannot use its
  GPU, which is the case worth knowing about.
  """
  import onnx_asr  # pylint: disable=import-outside-toplevel

  model = onnx_asr.load_model(
      MODEL_TYPE, path=model_dir, quantization=QUANTIZATION, providers=_providers()
  )
  sys.stderr.write(f"[asr] loaded parakeet from {model_dir} (requested {_providers()[0]})\n")
  try:
    # Best effort: the adapter does not promise this attribute, and a missing
    # log line must never be the reason transcription fails.
    session = getattr(model, "_encoder", None) or getattr(model, "_model", None)
    used = getattr(session, "_session", session)
    providers = used.get_providers() if hasattr(used, "get_providers") else None
    if providers:
      sys.stderr.write(f"[asr] onnxruntime providers in use: {providers}\n")
  except Exception:  # pylint: disable=broad-exception-caught
    pass
  sys.stderr.flush()
  return model


def transcribe_wav(model_dir: str, wav_bytes: bytes) -> str:
  """Thread-safe entry point: WAV bytes in, text out.

  Loads on first use so a Blurt install that has not downloaded the
  recogniser yet still starts the LLM sidecar normally - the cost of a
  missing model lands on the request that needs it, with a real error,
  rather than preventing the process from coming up at all.
  """
  pcm = decode_wav(wav_bytes)
  with _LOCK:
    if _STATE["model"] is None:
      _STATE["model"] = load(model_dir)
    # The waveform goes straight in as a float32 array - no temp file, and no
    # soundfile dependency to install.
    return str(_STATE["model"].recognize(pcm, sample_rate=SAMPLE_RATE)).strip()
