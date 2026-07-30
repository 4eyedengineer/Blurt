/**
 * Pure path-computation logic for `resolveServeGpuScriptPath` (see
 * `gpuWrapperPath.ts`), split into its own electron-free module so it can be
 * unit-tested directly under plain vitest/node - importing `electron` at
 * module scope (as `gpuWrapperPath.ts` does) breaks under vitest, since the
 * `electron` package's CJS/stub build doesn't support the named-export
 * interop vitest's ESM loader expects (there's nothing to actually resolve
 * outside a real Electron runtime) - matches this codebase's existing
 * convention of keeping electron-coupled code in its own thin file, with
 * pure logic factored out separately (see e.g. `sidecar.ts`/`portGuard.ts`,
 * neither of which import `electron` either).
 *
 * See `gpuWrapperPath.ts` for the two-case doc comment (dev vs packaged).
 */

/**
 * Joins one path segment onto `base`, preserving whichever separator style
 * `base` already uses (`\` or `/`) rather than the *host* OS's convention -
 * deliberately NOT `path.join` (which follows the host running the code,
 * not the path's own style), so this is deterministic and testable on any
 * host: a Windows-style `resourcesPath` (as Electron always reports at
 * runtime on a real Windows install) joins with a Windows-style result even
 * under a Linux test runner, and vice versa.
 */
function joinPreservingStyle(base: string, ...segments: string[]): string {
  const sep = base.includes('\\') ? '\\' : '/'
  const trimmedBase = base.endsWith('\\') || base.endsWith('/') ? base.slice(0, -1) : base
  return [trimmedBase, ...segments].join(sep)
}

export function computeServeGpuScriptPath(opts: {
  isDev: boolean
  appPath: string
  resourcesPath: string
}): string {
  if (opts.isDev) return joinPreservingStyle(opts.appPath, 'resources', 'serve_gpu.py')
  return joinPreservingStyle(opts.resourcesPath, 'serve_gpu.py')
}
