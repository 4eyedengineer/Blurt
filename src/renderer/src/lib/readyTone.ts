/**
 * The short "you can talk now" tone for the push-to-talk overlay.
 *
 * Why this exists: opening the mic is not instant. Every hold builds the
 * capture pipeline from scratch - `getUserMedia` (the physical device open,
 * which dominates on Windows: driver open plus echo-cancellation/noise-
 * suppression init), then an AudioContext, then the PCM AudioWorklet - and
 * tears it all down again on release. The overlay pill appears the instant
 * the key goes down, so without this tone the pill *looks* ready roughly a
 * second before audio is actually flowing, and the first words get clipped.
 *
 * So this must be played from the one moment that proves capture is live -
 * the arrival of the first PCM chunk from the worklet (see
 * useOverlayPushToTalk) - never from the keypress.
 *
 * Deliberately short and high-ish: it is unavoidably inside the recorded
 * audio (capture is live - that is the entire point), so it needs to be
 * something the mic's echo cancellation suppresses easily and the model
 * won't transcribe. The gain ramp at both ends is what keeps it a "tick"
 * rather than a click - an abrupt start/stop on a sine is a discontinuity,
 * and that broadband click is exactly the kind of transient that survives
 * echo cancellation.
 *
 * It is *not* deliberately quiet. The first version was (peak gain 0.06,
 * 70ms) and the result was inaudible in practice - which defeats the whole
 * point, since a cue you don't notice is the same as no cue. A pure sine is
 * a poor use of headroom: all its energy sits at one frequency, so it reads
 * far quieter than its amplitude suggests next to broadband sound. Hence
 * the values below - roughly 11dB hotter and half again as long, which is
 * comfortably audible over laptop speakers without being startling.
 * Loudness here costs nothing on the recognition side: a steady 880Hz tone
 * looks nothing like speech, and it lands in the first ~100ms of the
 * buffer, before anyone has started talking.
 */

const FREQUENCY_HZ = 880
const DURATION_S = 0.11
const PEAK_GAIN = 0.22
/** Attack/release of the gain envelope - long enough to avoid a click, short enough to stay inside DURATION_S. */
const RAMP_S = 0.012

let context: AudioContext | null = null

/** Lazily created and then reused - constructing an AudioContext per beep would itself cost more than the beep lasts. */
function getContext(): AudioContext {
  if (!context || context.state === 'closed') context = new AudioContext()
  return context
}

/**
 * Plays the tone. Never throws and never returns a rejected promise: a
 * failed beep must not take down a dictation that is otherwise working, so
 * any audio-output problem is swallowed (the user simply doesn't hear it).
 */
export function playReadyTone(): void {
  void playToneAsync()
}

async function playToneAsync(): Promise<void> {
  try {
    const ctx = getContext()
    // Resume BEFORE scheduling, and wait for it. An AudioContext can come
    // up suspended, and a suspended context's clock does not advance, so
    // notes scheduled against `currentTime` and stopped a tenth of a second
    // later can be over before it ever starts running. Firing resume() and
    // scheduling immediately anyway used to drop this beep every single
    // time in the push-to-talk overlay, which never receives a user gesture
    // that would resume the context implicitly (it is `focusable: false`
    // and driven by a global key hook). A cue that never plays is the same
    // as no cue, and worse, it reads as "the app did not hear me".
    if (ctx.state === 'suspended') await ctx.resume()

    const now = ctx.currentTime
    const oscillator = ctx.createOscillator()
    const gain = ctx.createGain()

    oscillator.type = 'sine'
    oscillator.frequency.setValueAtTime(FREQUENCY_HZ, now)

    gain.gain.setValueAtTime(0, now)
    gain.gain.linearRampToValueAtTime(PEAK_GAIN, now + RAMP_S)
    gain.gain.setValueAtTime(PEAK_GAIN, now + DURATION_S - RAMP_S)
    gain.gain.linearRampToValueAtTime(0, now + DURATION_S)

    oscillator.connect(gain)
    gain.connect(ctx.destination)
    oscillator.start(now)
    oscillator.stop(now + DURATION_S)
    oscillator.onended = () => {
      oscillator.disconnect()
      gain.disconnect()
    }
  } catch {
    // See doc comment - a silent beep is never worth failing a dictation.
  }
}
