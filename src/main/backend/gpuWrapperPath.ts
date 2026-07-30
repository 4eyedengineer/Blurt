import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { computeServeGpuScriptPath } from './gpuWrapperPathCore'

/**
 * Resolves the absolute path to `resources/serve_gpu.py` - the GPU-forcing
 * `litert-lm serve` wrapper (see that file's doc comment) - so it can be
 * substituted into a managed sidecar command's `{wrapperPath}` placeholder
 * (see `Accelerator` in shared/types.ts and `renderManagedCommand` in
 * sidecar.ts).
 *
 * Two cases (see `computeServeGpuScriptPath` in `gpuWrapperPathCore.ts` for
 * the pure, unit-tested implementation):
 * - Dev (`npm run dev` / electron-vite): `app.getAppPath()` is the repo
 *   root, so the script sits at `<repo>/resources/serve_gpu.py`.
 * - Packaged: `resources/serve_gpu.py` ships via electron-builder's
 *   `extraResources` (see electron-builder.yml), NOT `asarUnpack` - a
 *   Python file has no reason to sit inside (even an unpacked-sibling of)
 *   the asar archive at all, and `extraResources` is electron-builder's
 *   documented, first-class mechanism for "ship this file next to the exe,
 *   outside the app entirely". `extraResources` entries land directly under
 *   `process.resourcesPath` - the same directory that houses `app.asar`
 *   itself (`.../resources/app.asar` and `.../resources/serve_gpu.py` are
 *   siblings) - so the packaged path is simply
 *   `join(process.resourcesPath, 'serve_gpu.py')`, an Electron API that is
 *   correct by construction in every packaged build (installer or
 *   portable), unlike the previous `.asar` -> `.asar.unpacked` string-swap
 *   convention this replaced (never verified against a real build, and
 *   wrong for a plain `extraResources` file which was never inside the
 *   asar to begin with).
 */
export function resolveServeGpuScriptPath(): string {
  return computeServeGpuScriptPath({
    isDev: is.dev,
    appPath: app.getAppPath(),
    resourcesPath: process.resourcesPath
  })
}
