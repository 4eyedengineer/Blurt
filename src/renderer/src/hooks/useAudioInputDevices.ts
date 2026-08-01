import { useCallback, useEffect, useState } from 'react'

export interface AudioInputDevice {
  deviceId: string
  label: string
}

/**
 * Chromium's synthetic "track the system default" entries. Blurt already
 * models that itself with an empty `inputDeviceId`, so listing them too
 * would just be the same choice twice under a worse name.
 */
const PSEUDO_DEVICE_IDS = new Set(['default', 'communications'])

/** The audio inputs worth offering, from a raw `enumerateDevices()` list. */
export function toSelectableInputs(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  return devices
    .filter((d) => d.kind === 'audioinput' && !PSEUDO_DEVICE_IDS.has(d.deviceId))
    .map((d) => ({ deviceId: d.deviceId, label: d.label || 'Unnamed input' }))
}

/**
 * The microphones the user can actually pick from, kept current as devices
 * come and go (a headset connecting, a USB mic unplugged) via the
 * `devicechange` event.
 */
export function useAudioInputDevices(): AudioInputDevice[] {
  const [devices, setDevices] = useState<AudioInputDevice[]>([])

  const refresh = useCallback(async () => {
    try {
      let all = await navigator.mediaDevices.enumerateDevices()
      // Device labels are withheld until the page has been granted
      // microphone access at least once, and an unlabelled list of opaque
      // device ids is not a picker anyone can use. Opening a stream and
      // immediately closing it is the only way to unlock the names.
      if (all.some((d) => d.kind === 'audioinput' && !d.label)) {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
        stream.getTracks().forEach((track) => track.stop())
        all = await navigator.mediaDevices.enumerateDevices()
      }
      setDevices(toSelectableInputs(all))
    } catch (err) {
      // Leaves the picker on "System default" only, which still records.
      window.api.log.rendererError(
        `could not list audio inputs: ${err instanceof Error ? err.message : String(err)}`
      )
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() awaits enumerateDevices() before it ever calls setState, so no state is set synchronously during the effect and there is no cascading render to avoid.
    void refresh()
    navigator.mediaDevices.addEventListener('devicechange', refresh)
    return () => navigator.mediaDevices.removeEventListener('devicechange', refresh)
  }, [refresh])

  return devices
}
