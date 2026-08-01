import { describe, expect, it } from 'vitest'
import {
  shouldHideOnClose,
  shouldRegisterClickHandler,
  shouldUseTemplateImage,
  trayIconSizeFor
} from './tray'

/**
 * This predicate is the entire close-to-tray feature, and both ways of
 * getting it wrong are bad in ways a user would immediately notice:
 *
 * - hiding when it should quit leaves a process that no window can reach
 *   and that "Quit Blurt" cannot kill (the quit closes windows, which the
 *   handler would turn back into hides, cancelling the quit);
 * - quitting when it should hide tears down the sidecar and disarms the
 *   global push-to-talk hook the moment someone tidies their desktop -
 *   the exact opposite of what the feature is for.
 */
describe('shouldHideOnClose', () => {
  it('hides when running in the background and no quit is under way', () => {
    expect(shouldHideOnClose({ runInBackground: true, isQuitting: false })).toBe(true)
  })

  it('quits when the setting is off', () => {
    expect(shouldHideOnClose({ runInBackground: false, isQuitting: false })).toBe(false)
  })

  // The load-bearing case. Electron closes every window during a quit, so a
  // handler that still hid them would silently cancel the quit - "Quit
  // Blurt" from the tray would just re-hide the window and the app would
  // become impossible to shut down by any normal means.
  it('never hides once a quit has started, even with the setting on', () => {
    expect(shouldHideOnClose({ runInBackground: true, isQuitting: true })).toBe(false)
  })

  it('quits when the setting is off and a quit has started', () => {
    expect(shouldHideOnClose({ runInBackground: false, isQuitting: true })).toBe(false)
  })
})

describe('trayIconSizeFor', () => {
  it('uses the 22x22 NSStatusItem size on macOS', () => {
    expect(trayIconSizeFor('darwin')).toBe(22)
  })

  it('uses the 16x16 Windows notification-area size everywhere else', () => {
    expect(trayIconSizeFor('win32')).toBe(16)
    expect(trayIconSizeFor('linux')).toBe(16)
  })
})

describe('shouldUseTemplateImage', () => {
  it('is true only on macOS', () => {
    expect(shouldUseTemplateImage('darwin')).toBe(true)
  })

  it('is false on Windows and Linux', () => {
    expect(shouldUseTemplateImage('win32')).toBe(false)
    expect(shouldUseTemplateImage('linux')).toBe(false)
  })
})

/**
 * Both directions matter here, same as `shouldHideOnClose` above: registering
 * the handler on macOS would be redundant at best against the context menu
 * Electron already shows there, while failing to register it on Windows/Linux
 * would leave a plain left-click doing nothing - silently removing the
 * documented "click to open" affordance and leaving only the right-click menu.
 */
describe('shouldRegisterClickHandler', () => {
  it('is false on macOS, where a context-menu click is not an "open" signal', () => {
    expect(shouldRegisterClickHandler('darwin')).toBe(false)
  })

  it('is true on Windows and Linux', () => {
    expect(shouldRegisterClickHandler('win32')).toBe(true)
    expect(shouldRegisterClickHandler('linux')).toBe(true)
  })
})
