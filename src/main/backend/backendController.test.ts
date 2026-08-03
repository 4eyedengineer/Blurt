import { describe, expect, it, vi } from 'vitest'

// backendController pulls in electron transitively (gpuWrapperPath -> app).
// Nothing under test here touches it - see overlayController.test.ts for the
// same two lines.
vi.mock('electron', () => ({ app: { getAppPath: () => '' } }))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }))

const { describeBackendFailure } = await import('./backendController')

/**
 * What the user is told when the backend is unusable, in place of the
 * engine's own account of the failure.
 *
 * Reported from a real session: with no model installed, the status pill
 * said "Error" and the Dictate screen carried a full sentence of engine
 * diagnostics. The fix is a disabled record button plus one of these - the
 * button says "not now", these say which of three things to do about it.
 */
describe('describeBackendFailure', () => {
  it('names the missing model as the problem when none is installed', () => {
    expect(describeBackendFailure('managed', false)).toBe('No model installed.')
  })

  it('says the model failed to load when one is installed but the engine did not come up', () => {
    expect(describeBackendFailure('managed', true)).toBe('The model could not be loaded.')
  })

  /**
   * In 'external' mode Blurt spawns nothing and manages no model files - the
   * user pointed it at a server they run themselves. "No model installed" is
   * a claim about a model store that isn't in play, and it would send them
   * to a Settings download button that cannot fix anything.
   */
  it('does not talk about installing a model in external mode', () => {
    expect(describeBackendFailure('external', false)).toBe('Cannot reach the engine.')
    expect(describeBackendFailure('external', true)).toBe('Cannot reach the engine.')
  })

  /**
   * These are rendered inline next to a disabled button, which is the whole
   * point of them - a length check is the only thing standing between that
   * and someone pasting a stderr tail back in here later.
   */
  it('stays short enough to sit on one line', () => {
    const all = [
      describeBackendFailure('managed', false),
      describeBackendFailure('managed', true),
      describeBackendFailure('external', true)
    ]
    for (const message of all) {
      expect(message.length).toBeLessThanOrEqual(40)
      expect(message).not.toContain('\n')
    }
  })
})
