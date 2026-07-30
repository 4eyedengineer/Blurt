import { describe, expect, it } from 'vitest'
import { computeServeGpuScriptPath } from './gpuWrapperPathCore'

describe('computeServeGpuScriptPath', () => {
  it('resolves under the repo root in dev mode, ignoring resourcesPath', () => {
    const path = computeServeGpuScriptPath({
      isDev: true,
      appPath: '/home/user/dev/windows-eloquent',
      resourcesPath: '/some/unrelated/resources'
    })
    expect(path).toBe('/home/user/dev/windows-eloquent/resources/serve_gpu.py')
  })

  it('resolves directly under process.resourcesPath when packaged', () => {
    const path = computeServeGpuScriptPath({
      isDev: false,
      appPath: 'C:\\Program Files\\WindowsEloquent\\resources\\app.asar',
      resourcesPath: 'C:\\Program Files\\WindowsEloquent\\resources'
    })
    expect(path).toBe('C:\\Program Files\\WindowsEloquent\\resources\\serve_gpu.py')
  })

  it('packaged resolution does not depend on appPath ending in .asar', () => {
    // extraResources land next to app.asar regardless of appPath's shape -
    // the old .asar/.asar.unpacked convention this replaced cared about
    // that; resourcesPath-based resolution never needs to.
    const path = computeServeGpuScriptPath({
      isDev: false,
      appPath: '/whatever/app.asar',
      resourcesPath: '/opt/WindowsEloquent/resources'
    })
    expect(path).toBe('/opt/WindowsEloquent/resources/serve_gpu.py')
  })
})
