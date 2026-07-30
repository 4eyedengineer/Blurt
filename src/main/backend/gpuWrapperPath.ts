import { app } from 'electron'
import { is } from '@electron-toolkit/utils'
import { join } from 'path'

/**
 * Resolves the absolute path to `resources/serve_gpu.py` - the GPU-forcing
 * `litert-lm serve` wrapper (see that file's doc comment) - so it can be
 * substituted into a managed sidecar command's `{wrapperPath}` placeholder
 * (see `Accelerator` in shared/types.ts and `renderManagedCommand` in
 * sidecar.ts).
 *
 * Two cases:
 * - Dev (`npm run dev` / electron-vite): `app.getAppPath()` is the repo
 *   root, so the script sits at `<repo>/resources/serve_gpu.py`. This is
 *   the path exercised in practice today (Start-Eloquent.ps1 runs `npm run
 *   dev`, it doesn't build/launch a packaged .exe).
 * - Packaged: electron-builder.yml unpacks `resources/**` from the asar
 *   archive (`asarUnpack: [resources/**]`) into a sibling
 *   `app.asar.unpacked` directory, since a spawned child process can't
 *   read a file that's still packed inside `app.asar`. `app.getAppPath()`
 *   for a packaged app returns `.../resources/app.asar`; swapping that
 *   suffix for `app.asar.unpacked` is electron-builder's documented
 *   convention for reaching unpacked files. NOTE: this half is unverified
 *   against a real built installer/portable exe as of this writing (no
 *   packaged build was produced or run as part of this change) - if GPU
 *   mode ever fails specifically in a packaged build with a "file not
 *   found" style error, check this path resolution first.
 */
export function resolveServeGpuScriptPath(): string {
  const appPath = app.getAppPath()
  const base = is.dev || !appPath.endsWith('.asar') ? appPath : `${appPath}.unpacked`
  return join(base, 'resources', 'serve_gpu.py')
}
