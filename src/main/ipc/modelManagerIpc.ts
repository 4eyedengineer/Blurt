import { BrowserWindow, ipcMain } from 'electron'
import { IPC } from '../../shared/ipc-channels'
import type { ModelId } from '../../shared/types'
import type { HardwareProbeResult } from '../../shared/hardware'
import type { ModelManager } from '../backend/modelManager'
import { resolveManagedCliForImport } from '../backend/sidecar'
import { probeHardware } from '../hardware/hardwareProbe'
import type { SettingsStore } from '../store/settingsStore'
import type { VenvPaths } from '../runtime/venvResolver'

/**
 * Wires the ModelManager (download/list/cancel/remove) up to IPC, forwarding
 * progress events to the renderer for the Settings screen's progress bars.
 *
 * `venvPaths` is needed for one reason: the download's import step has to
 * resolve the litert-lm CLI out of the managed sidecar command, and the
 * default command is a *template* referencing `{venvPython}` - see
 * `resolveManagedCliForImport`. Undefined on platforms that do not manage a
 * runtime of their own (Linux/WSL dev builds), where the command is expected
 * to be a real path already.
 */
export function registerModelManagerIpc(
  modelManager: ModelManager,
  settingsStore: SettingsStore,
  getWindow: () => BrowserWindow | null,
  venvPaths?: VenvPaths
): void {
  ipcMain.handle(IPC.models.list, () => ({
    installed: modelManager.listInstalled(),
    progress: modelManager.getAllProgress()
  }))

  ipcMain.handle(IPC.models.download, (_event, modelId: ModelId) => {
    // The download's final `litert-lm import` step (see ModelManager class
    // doc) has to shell out to the litert-lm CLI, resolved from the managed
    // sidecar command (see resolveImportCli's doc comment for why that's
    // not simply "the managed command's first token") so the import lands
    // where `serve` will find it.
    //
    // This MUST be the placeholder-aware resolver, not the raw
    // `resolveImportCli`. The default managed command is a template
    // referencing `{venvPython}` (see DEFAULT_MANAGED_COMMAND), and
    // `resolveImportCli` name-sniffs the first token as a real path - so on
    // a fresh install it saw the literal "{venvPython}", matched neither a
    // litert-lm nor a python name, and hard-errored. That made the Download
    // button in Settings fail 100% of the time for every new user, while
    // BackendController's own import path (which already used the
    // placeholder-aware resolver) worked - so the bug was invisible on any
    // machine whose settings.json had a hand-edited absolute-path command.
    const cliResolution = resolveManagedCliForImport(
      settingsStore.get().sidecar.managedCommand,
      venvPaths
    )
    // Fire-and-forget: progress/completion (including a resolution failure) is reported via the 'progress' event.
    void modelManager.download(modelId, cliResolution)
  })

  ipcMain.handle(IPC.models.cancelDownload, (_event, modelId: ModelId) => {
    modelManager.cancelDownload(modelId)
  })

  ipcMain.handle(IPC.models.remove, (_event, modelId: ModelId) => {
    modelManager.remove(modelId)
  })

  // Raw facts only - the Settings screen applies the same shared/modelRequirements.ts
  // policy to these that download() uses to gate itself, so the two never
  // drift apart. Re-probed on every call (not cached) since free disk space
  // can change between visits to the Settings screen.
  ipcMain.handle(IPC.models.hardware, (): Promise<HardwareProbeResult> =>
    probeHardware(modelManager.getModelsDir())
  )

  modelManager.on('progress', (progress) => {
    getWindow()?.webContents.send(IPC.models.progress, progress)
  })
}
