/**
 * AudioWorkletProcessor that downsamples the mic's native sample rate to
 * ~16kHz mono and buffers it into fixed-size Int16 PCM chunks, posting each
 * chunk back to the main thread as a transferable ArrayBuffer.
 *
 * This file is intentionally plain JS (not bundled by Vite) - it runs in
 * the isolated AudioWorkletGlobalScope, not a normal module context. It is
 * served as a static asset from src/renderer/public and loaded via
 * `audioContext.audioWorklet.addModule(...)`.
 */

const TARGET_SAMPLE_RATE = 16000
const CHUNK_SIZE = 2048 // samples at TARGET_SAMPLE_RATE (~128ms per chunk)

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this.inputSampleRate = sampleRate // global provided by AudioWorkletGlobalScope
    this.resampleRatio = this.inputSampleRate / TARGET_SAMPLE_RATE
    this.pending = []
    this.sampleAccumulator = 0
  }

  process(inputs) {
    const input = inputs[0]
    const channel = input && input[0]
    if (!channel || channel.length === 0) return true

    for (let i = 0; i < channel.length; i++) {
      this.sampleAccumulator += 1
      if (this.sampleAccumulator >= this.resampleRatio) {
        this.sampleAccumulator -= this.resampleRatio
        const sample = Math.max(-1, Math.min(1, channel[i]))
        this.pending.push(sample < 0 ? sample * 0x8000 : sample * 0x7fff)
      }
    }

    while (this.pending.length >= CHUNK_SIZE) {
      const chunkSamples = this.pending.splice(0, CHUNK_SIZE)
      const int16 = new Int16Array(chunkSamples.length)
      for (let i = 0; i < chunkSamples.length; i++) {
        int16[i] = chunkSamples[i]
      }
      this.port.postMessage(int16.buffer, [int16.buffer])
    }

    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
