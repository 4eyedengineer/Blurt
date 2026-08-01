import { describe, expect, it } from 'vitest'
import { toSelectableInputs } from './useAudioInputDevices'

/** Minimal stand-in for the fields of MediaDeviceInfo this actually reads. */
function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: 'g', toJSON: () => ({}) } as MediaDeviceInfo
}

describe('toSelectableInputs', () => {
  it('keeps only audio inputs', () => {
    const result = toSelectableInputs([
      device('audioinput', 'mic-1', 'Headset'),
      device('audiooutput', 'spk-1', 'Speakers'),
      device('videoinput', 'cam-1', 'Webcam')
    ])
    expect(result).toEqual([{ deviceId: 'mic-1', label: 'Headset' }])
  })

  it("drops Chromium's default/communications aliases, which duplicate the app's own System default option", () => {
    const result = toSelectableInputs([
      device('audioinput', 'default', 'Default - Headset'),
      device('audioinput', 'communications', 'Communications - Headset'),
      device('audioinput', 'mic-1', 'Headset')
    ])
    expect(result).toEqual([{ deviceId: 'mic-1', label: 'Headset' }])
  })

  it('names an unlabelled input rather than rendering a blank row', () => {
    expect(toSelectableInputs([device('audioinput', 'mic-1', '')])).toEqual([
      { deviceId: 'mic-1', label: 'Unnamed input' }
    ])
  })

  it('is empty when nothing can record', () => {
    expect(toSelectableInputs([device('audiooutput', 'spk-1', 'Speakers')])).toEqual([])
  })
})
