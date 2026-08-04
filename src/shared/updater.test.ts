import { describe, expect, it } from 'vitest'
import { describeUpdateStatus, describeUpdateSupport, type UpdateStatus } from './updater'

describe('describeUpdateSupport', () => {
  it('supports a packaged Windows build', () => {
    expect(describeUpdateSupport({ platform: 'win32', isPackaged: true })).toEqual({
      supported: true
    })
  })

  it('refuses an unpackaged build on every platform, including Windows', () => {
    // electron-updater declines here itself ("Skip checkForUpdates because
    // application is not packed"), so without this branch a dev build would
    // sit on 'checking' for ever with nothing explaining why.
    for (const platform of ['win32', 'darwin', 'linux'] as NodeJS.Platform[]) {
      const support = describeUpdateSupport({ platform, isPackaged: false })
      expect(support.supported).toBe(false)
      expect(support.supported === false && support.reason).toMatch(/development/i)
    }
  })

  it('refuses macOS, and says signing is the reason rather than the platform', () => {
    // Squirrel.Mac will not replace an unsigned app. Worth being specific:
    // this is a missing certificate, not something inherent to macOS, and the
    // answer changes the day the mac build gets signed.
    const support = describeUpdateSupport({ platform: 'darwin', isPackaged: true })
    expect(support.supported).toBe(false)
    expect(support.supported === false && support.reason).toMatch(/signed/i)
  })

  it('refuses any other platform', () => {
    const support = describeUpdateSupport({ platform: 'linux', isPackaged: true })
    expect(support.supported).toBe(false)
    expect(support.supported === false && support.reason).toMatch(/Windows/)
  })
})

describe('describeUpdateStatus', () => {
  it('only claims the app is up to date for a check that actually came back empty', () => {
    // The load-bearing one. 'idle' is the ONLY state allowed to make this
    // claim - 'checking' has not heard back yet, and 'error' means the check
    // never completed, so saying "up to date" in either would be asserting
    // something nobody has established.
    expect(describeUpdateStatus({ state: 'idle' })).toBe('Blurt is up to date.')
    for (const state of ['checking', 'error', 'downloading', 'ready', 'unsupported'] as const) {
      expect(describeUpdateStatus({ state } as UpdateStatus)).not.toMatch(/up to date/i)
    }
  })

  it('tells the user a ready update applies on quit, without them doing anything', () => {
    const line = describeUpdateStatus({ state: 'ready', version: '1.4.3' })
    expect(line).toContain('1.4.3')
    expect(line).toMatch(/quit/i)
  })

  it('reports download progress, and copes with a tick that has no percentage yet', () => {
    expect(describeUpdateStatus({ state: 'downloading', version: '1.4.3', percent: 42 })).toBe(
      'Downloading 1.4.3… 42%'
    )
    expect(describeUpdateStatus({ state: 'downloading', version: '1.4.3' })).toBe(
      'Downloading 1.4.3…'
    )
  })

  it('passes through the reason an unsupported build cannot update', () => {
    expect(
      describeUpdateStatus({ state: 'unsupported', detail: 'Development builds do not update.' })
    ).toBe('Development builds do not update.')
  })

  it('never renders undefined, whatever fields a status is missing', () => {
    const states = ['unsupported', 'idle', 'checking', 'downloading', 'ready', 'error'] as const
    for (const state of states) {
      const line = describeUpdateStatus({ state })
      expect(line).not.toContain('undefined')
      expect(line.length).toBeGreaterThan(0)
    }
  })
})
