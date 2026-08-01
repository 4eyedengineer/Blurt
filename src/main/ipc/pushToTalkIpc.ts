import { ipcMain, systemPreferences } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { PushToTalkStatus } from '../../shared/types'
import type { PushToTalkController } from '../pushToTalk/pushToTalkController'
import { checkXdotoolAvailable } from '../paste'
import { detectWSLReal } from '../wsl'

/**
 * Shared status assembly for both IPC handlers below, so the two never
 * drift out of sync. `accessibilityGranted` defaults to a fresh
 * `controller.getAccessibilityStatus()` query (null off darwin) - callers
 * that already have a just-computed value (see `requestAccessibility`
 * below) pass it in instead of paying for a second, redundant query.
 */
async function buildStatus(
  controller: PushToTalkController,
  accessibilityGranted: boolean | null = controller.getAccessibilityStatus()
): Promise<PushToTalkStatus> {
  const availability = controller.getAvailability()
  return {
    available: availability.available,
    reason: availability.reason,
    platform: process.platform,
    isWSL: detectWSLReal(),
    xdotoolAvailable: process.platform === 'linux' ? await checkXdotoolAvailable() : null,
    accessibilityGranted
  }
}

export function registerPushToTalkIpc(controller: PushToTalkController): void {
  ipcMain.handle(IPC.pushToTalk.getStatus, async (): Promise<PushToTalkStatus> =>
    buildStatus(controller)
  )

  /**
   * Two-step "grant then arm" action for the darwin-only Settings button
   * (see SettingsScreen.tsx): first raises the real system prompt via the
   * *prompting* form of `isTrustedAccessibilityClient` (its `true` argument
   * is what deep-links to System Settings > Privacy & Security >
   * Accessibility - the `getStatus` handler above only ever uses the
   * non-prompting `false` form via the controller, and must never trigger
   * this dialog on its own), then re-runs the controller's re-check so a
   * hook that was previously refused gets started immediately if the user
   * actually granted it, without waiting for anything else to notice.
   * No-op prompt (but still returns fresh status) on every non-darwin
   * platform - `isTrustedAccessibilityClient` itself is darwin-only.
   */
  ipcMain.handle(IPC.pushToTalk.requestAccessibility, async (): Promise<PushToTalkStatus> => {
    if (process.platform === 'darwin') {
      systemPreferences.isTrustedAccessibilityClient(true)
    }
    return buildStatus(controller, controller.recheckAccessibility())
  })
}
