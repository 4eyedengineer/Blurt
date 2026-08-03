#!/usr/bin/env python
"""Speech recognition for Blurt, using a small dedicated `.tflite` recogniser
instead of routing audio through the multimodal LLM.

## Why this exists

Blurt used to transcribe by handing a WAV to Gemma 4 E2B - a 2.5 GB
multimodal chat model - and asking it to write down what it heard. That
works, but it is the wrong tool twice over.

Measured on this project against 25 LibriSpeech clips (463 reference words,
one Windows machine, same audio and same scorer throughout; the recognisers
on CPU, Gemma on its GPU):

    Model                    Size      WER     3s window
    whisper-acft tiny.en     61 MB   10.37%       442ms
    whisper-acft base.en    103 MB    6.26%       651ms
    Gemma 4 E2B           2,588 MB    6.48%           -
    whisper-acft small.en   289 MB    3.46%      2157ms

An earlier 6-clip run put tiny.en at 4.14% and appeared to beat Gemma
outright. It did not survive a larger sample, and the ordering above is the
one to trust: on this task the small model is not a free win, and picking
one is a real trade between accuracy and how fast a window can be read.

The two families also fail differently, which matters as much as the rate.
Gemma's errors stay fluent - "similes drawn from eating" came back as "his
drawn from eating" - because a language model asked to transcribe will
happily finish a sentence it only half heard. A recogniser has no such
instinct: its errors are words it genuinely could not make out, usually
unfamiliar proper nouns, which read as mistakes rather than as things you
said.

So Blurt runs two of them, because the live transcript and the final text
want opposite things. A dictation costs many transcription calls (3 to 14 in
observed real sessions) and one final pass. Every tick's cost is paid again
in how often the words on screen refresh, while the final pass happens once
and its output is what gets pasted and saved.

    live ticks   base.en    651ms per window -> ~800ms cadence
    final pass   small.en   3.46% WER, roughly half Gemma's error rate

Gemma keeps everything downstream of the words: cleanup, transforms and
voice edit. Only transcription moves. This is the same split Google's own
Eloquent app uses - a small speech expert feeding a Gemma that does the
language work.

The GPU is not an option here, and not for want of trying: the WebGPU
accelerator that ships with ai-edge-litert registers fine on Windows and
then fails to compile these graphs, identically across every GpuOptions
variant (default, enforce_f32, allow_src_quantized_fc_conv_ops, and both
together). Both recognisers run on CPU via XNNPACK, which at least leaves
the GPU entirely to Gemma.

## What the model file actually wants

Two things here are not what the model card says, and both produce
plausible-looking garbage rather than an error when got wrong.

  1. The card documents `decode`'s inputs as (mask, audio, tokens). The real
     graph order is (audio, tokens, mask). So inputs are bound by SHAPE, not
     by position or documented name - see `_bind_decode_inputs`.
  2. The attention mask is ADDITIVE (0 where a position may be attended, a
     large negative elsewhere), not multiplicative 1/0.

The encoder's own input shape decides the audio window: these are fixed
5s/10s/30s exports, and `[1, 80, frames]` gives `frames` directly. Nothing
here hard-codes Whisper's usual 3000, because that is only right for the 30s
build - see `log_mel`.

## Threading

`Interpreter` is not safe to call from two threads at once, and the HTTP
server this is mounted in is threaded. Every call goes through `_LOCK`, so
concurrent transcription requests queue rather than corrupting each other's
tensors. Requests are short (well under a second) and the partial-tick
scheduler on the Electron side already drops overlapping ticks, so queueing
is the right trade against the memory cost of a second interpreter.
"""

from __future__ import annotations

import io
import os
import sys
import threading
import wave

import numpy as np

SAMPLE_RATE = 16000
N_FFT = 400
HOP = 160
N_MELS = 80

#: Hard bound on generated tokens per request. The decoder's own token buffer
#: is the real ceiling; this only stops a pathological repeat loop from
#: burning the full buffer on every request.
MAX_NEW_TOKENS = 200

_LOCK = threading.Lock()

#: Loaded interpreters, keyed by model path, so more than one recogniser can
#: be resident at once. Blurt runs two: a smaller one for the live transcript,
#: where a tick's cost sets the cadence, and a larger, more accurate one for
#: the single final pass, whose output is what gets pasted and saved. Which is
#: which is decided by the caller - this module only caches whatever it is
#: given, so the two roles cost one load each rather than one per request.
_MODELS: dict[str, dict] = {}


def _hz_to_mel(freq):
  """Slaney mel scale (librosa's htk=False), which is what Whisper's front end uses."""
  f_sp = 200.0 / 3
  mels = freq / f_sp
  min_log_hz = 1000.0
  min_log_mel = min_log_hz / f_sp
  logstep = np.log(6.4) / 27.0
  return np.where(freq >= min_log_hz, min_log_mel + np.log(freq / min_log_hz) / logstep, mels)


def _mel_to_hz(mel):
  f_sp = 200.0 / 3
  freqs = f_sp * mel
  min_log_hz = 1000.0
  min_log_mel = min_log_hz / f_sp
  logstep = np.log(6.4) / 27.0
  return np.where(mel >= min_log_mel, min_log_hz * np.exp(logstep * (mel - min_log_mel)), freqs)


def _mel_filterbank():
  """80 triangular filters with Slaney area normalisation -> (80, 201)."""
  fftfreqs = np.fft.rfftfreq(N_FFT, 1.0 / SAMPLE_RATE)
  pts = _mel_to_hz(np.linspace(_hz_to_mel(0.0), _hz_to_mel(SAMPLE_RATE / 2.0), N_MELS + 2))
  fdiff = np.diff(pts)
  ramps = pts[:, None] - fftfreqs[None, :]
  weights = np.zeros((N_MELS, len(fftfreqs)), dtype=np.float64)
  for i in range(N_MELS):
    lower = -ramps[i] / fdiff[i]
    upper = ramps[i + 2] / fdiff[i + 1]
    weights[i] = np.maximum(0.0, np.minimum(lower, upper))
  weights *= (2.0 / (pts[2 : N_MELS + 2] - pts[:N_MELS]))[:, None]
  return weights


_FILTERS = None


def log_mel(pcm: np.ndarray, n_frames: int) -> np.ndarray:
  """Whisper's log-mel front end -> (80, n_frames) float32.

  Reflect-padded STFT, power spectrum with the final frame dropped, Slaney
  mel projection, log10, an 8 dB floor relative to the peak, then scaled
  into roughly [-1, 1].

  `n_frames` is taken from the encoder's input shape by the caller rather
  than hard-coded, because these are fixed-window exports - see this
  module's doc comment.
  """
  global _FILTERS
  if _FILTERS is None:
    _FILTERS = _mel_filterbank()

  want = n_frames * HOP
  pcm = np.pad(pcm, (0, want - len(pcm))) if len(pcm) < want else pcm[:want]

  padded = np.pad(pcm, N_FFT // 2, mode="reflect")
  window = np.hanning(N_FFT + 1)[:-1]
  count = 1 + (len(padded) - N_FFT) // HOP
  frames = np.lib.stride_tricks.as_strided(
      padded, shape=(count, N_FFT), strides=(padded.strides[0] * HOP, padded.strides[0])
  )
  power = (np.abs(np.fft.rfft(frames * window, axis=-1)) ** 2)[:-1].T

  mel = _FILTERS @ power
  # clip before log10: a digitally silent buffer produces exact zeros, and
  # log10(0) is a warning and -inf that then poisons the whole array via the
  # max() below.
  log_spec = np.log10(np.clip(mel, 1e-10, None))
  log_spec = np.maximum(log_spec, log_spec.max() - 8.0)
  return ((log_spec + 4.0) / 4.0).astype(np.float32)


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


def _bind_decode_inputs(details, audio_shape):
  """Maps this graph's decode inputs to their roles BY SHAPE.

  The model card documents the order as (mask, audio, tokens); the graph's
  actual order is (audio, tokens, mask), and the names are `args_0/1/2`
  either way. Binding by documented position produces a model that runs and
  returns fluent nonsense, so the three roles are told apart by the only
  thing that is unambiguous: rank and shape. Audio matches the encoder's
  output exactly, tokens are the rank-2 input, the mask is the rank-4 one.
  """
  by_shape = {tuple(int(d) for d in v["shape"]): k for k, v in details.items()}
  audio_key = by_shape.get(tuple(int(d) for d in audio_shape))
  token_key = next((k for s, k in by_shape.items() if len(s) == 2), None)
  mask_key = next((k for s, k in by_shape.items() if len(s) == 4), None)
  if audio_key is None or token_key is None or mask_key is None:
    raise RuntimeError(
        "unrecognised decode signature - could not identify the audio/token/mask "
        f"inputs among shapes {sorted(by_shape)}"
    )
  return audio_key, token_key, mask_key


def _causal_mask(length: int, positions: int) -> np.ndarray:
  """Additive causal mask: 0 where attention is allowed, a large negative
  elsewhere. Multiplicative 1/0 also runs, and also returns fluent nonsense.
  """
  allowed = np.tril(np.ones((positions, positions), dtype=np.float32))
  allowed[length:, :] = 0.0
  allowed[:, length:] = 0.0
  return np.where(allowed > 0, 0.0, -1e9).astype(np.float32)[None, None]


def load(model_path: str, tokenizer_path: str, num_threads: int = 4) -> dict:
  """Loads the recogniser. Called once, lazily, on the first transcription."""
  from ai_edge_litert.interpreter import Interpreter  # pylint: disable=import-outside-toplevel
  from tokenizers import Tokenizer  # pylint: disable=import-outside-toplevel

  interpreter = Interpreter(model_path=model_path, num_threads=num_threads)
  encode = interpreter.get_signature_runner("encode")
  decode = interpreter.get_signature_runner("decode")
  tokenizer = Tokenizer.from_file(tokenizer_path)
  vocab = tokenizer.get_vocab()
  frames = int(next(iter(encode.get_input_details().values()))["shape"][-1])

  sys.stderr.write(
      f"[asr] loaded {os.path.basename(model_path)} "
      f"(window {frames * HOP / SAMPLE_RATE:.0f}s, {num_threads} threads)\n"
  )
  sys.stderr.flush()
  return {
      "encode": encode,
      "decode": decode,
      "tokenizer": tokenizer,
      "frames": frames,
      "ids": {
          "sot": vocab["<|startoftranscript|>"],
          "eot": vocab["<|endoftext|>"],
          "no_ts": vocab["<|notimestamps|>"],
      },
  }


def transcribe(state: dict, pcm: np.ndarray) -> str:
  """Greedy decode of one audio window -> text.

  Deliberately greedy rather than beam search: dictation is re-transcribed
  every ~1.5s while the user speaks, so per-call latency matters more here
  than the last fraction of a percent of accuracy.
  """
  mel = log_mel(pcm, state["frames"])[None]
  audio = state["encode"](args_0=mel)["output_0"]

  decode = state["decode"]
  audio_key, token_key, mask_key = _bind_decode_inputs(decode.get_input_details(), audio.shape)
  positions = int(decode.get_input_details()[token_key]["shape"][-1])

  ids = state["ids"]
  prompt = [ids["sot"], ids["no_ts"]]
  # Padded with EOT rather than 0: 0 is a real token, and the model attends
  # to the whole fixed-width buffer.
  buf = np.full((1, positions), ids["eot"], dtype=np.int32)
  buf[0, : len(prompt)] = prompt
  cur = len(prompt)

  out: list[int] = []
  for _ in range(min(MAX_NEW_TOKENS, positions - len(prompt))):
    logits = decode(
        **{audio_key: audio, token_key: buf, mask_key: _causal_mask(cur, positions)}
    )["output_0"]
    nxt = int(np.argmax(logits[0, cur - 1]))
    if nxt == ids["eot"]:
      break
    out.append(nxt)
    buf[0, cur] = nxt
    cur += 1

  return state["tokenizer"].decode(out).strip()


def transcribe_wav(model_path: str, tokenizer_path: str, wav_bytes: bytes) -> str:
  """Thread-safe entry point: WAV bytes in, text out, using the recogniser at
  `model_path`.

  Loads on first use, and only the models actually asked for - a session
  that never reaches its final pass never pays to load the larger model.
  Deferring the load this way also means a Blurt install that has not
  downloaded a recogniser yet still starts the LLM sidecar normally: the
  cost of a missing model lands on the request that needs it, with a real
  error, rather than preventing the process from coming up at all.
  """
  pcm = decode_wav(wav_bytes)
  with _LOCK:
    state = _MODELS.get(model_path)
    if state is None:
      state = _MODELS[model_path] = load(model_path, tokenizer_path)
    return transcribe(state, pcm)
