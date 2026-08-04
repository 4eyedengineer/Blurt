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
  venvPaths?: VenvPaths,
  /**
   * Lets a destructive model operation release the files the running engine
   * holds open, and bring the backend back afterwards. Deleting a model
   * without this leaves the sidecar serving the copy that was supposedly
   * just deleted - see `BackendController.releaseModelFiles`. Optional so
   * tests can register the IPC without a whole backend.
   */
  backend?: { releaseModelFiles: () => void; rebuild: () => Promise<void> }
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

  ipcMain.handle(IPC.models.remove, async (_event, modelId: ModelId) => {
    // Stop the engine before deleting, then bring it back. The imported copy
    // is memory-mapped by the running sidecar, and Windows will not delete a
    // mapped file - so without the release, the deletion of that copy fails
    // while the deletion of the download succeeds, leaving Settings saying
    // "not installed" and the status pill saying "Ready" about the same
    // model.
    //
    // The rebuild afterwards is what makes the pill honest again: with the
    // model gone it lands in an error state naming the missing model,
    // instead of continuing to report a healthy engine that is only healthy
    // because it is still holding a file the user asked to delete.
    //
    // `remove` is awaited, and that is load-bearing rather than tidiness.
    // It is async (it retries the imported copy for up to 3s while the
    // engine's file handle closes) and it can reject outright, since
    // deleting the downloaded file is a bare `unlinkSync` that throws if
    // Windows still has it open. Unawaited, that rejection went nowhere
    // while this handler resolved successfully, so the renderer was told a
    // deletion had happened that had not - the exact silent failure
    // `remove`'s own doc comment promises not to allow. Awaiting also means
    // the rebuild below runs after the files are actually gone rather than
    // racing the retry loop.
    backend?.releaseModelFiles()
    await modelManager.remove(modelId)
    if (backend) await backend.rebuild()
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
