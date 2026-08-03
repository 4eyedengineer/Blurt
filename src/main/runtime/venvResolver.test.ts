import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  RUNTIME_MARKER_FILENAME,
  runtimePipSpecs,
  getRuntimeBaseDir,
  isRuntimeManagedPlatform,
  isVenvHealthy,
  runtimeMarkerContents,
  venvPathsFor
} from './venvResolver'

describe('venvPathsFor', () => {
  it('uses Scripts\\*.exe on win32', () => {
    const paths = venvPathsFor('C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv', 'win32')
    expect(paths.pythonExe).toBe(
      'C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv\\Scripts\\python.exe'
    )
    expect(paths.litertLmExe).toBe(
      'C:\\Users\\testuser\\AppData\\Local\\Blurt\\venv\\Scripts\\litert-lm.exe'
    )
  })

  it('uses bin/* with no suffix on posix platforms', () => {
    const paths = venvPathsFor('/home/user/.local/venv', 'linux')
    expect(paths.pythonExe).toBe('/home/user/.local/venv/bin/python')
    expect(paths.litertLmExe).toBe('/home/user/.local/venv/bin/litert-lm')
  })

  it('uses bin/* with no suffix on darwin, same as other posix platforms', () => {
    const paths = venvPathsFor('/Users/testuser/Library/Application Support/Blurt/venv', 'darwin')
    expect(paths.pythonExe).toBe(
      '/Users/testuser/Library/Application Support/Blurt/venv/bin/python'
    )
    expect(paths.litertLmExe).toBe(
      '/Users/testuser/Library/Application Support/Blurt/venv/bin/litert-lm'
    )
  })
})

describe('isRuntimeManagedPlatform', () => {
  it('is true for win32 and darwin', () => {
    expect(isRuntimeManagedPlatform('win32')).toBe(true)
    expect(isRuntimeManagedPlatform('darwin')).toBe(true)
  })

  it('is false for linux and other platforms', () => {
    expect(isRuntimeManagedPlatform('linux')).toBe(false)
    expect(isRuntimeManagedPlatform('freebsd')).toBe(false)
    expect(isRuntimeManagedPlatform('aix')).toBe(false)
  })
})

describe('getRuntimeBaseDir', () => {
  it('joins LOCALAPPDATA with Blurt on win32', () => {
    expect(
      getRuntimeBaseDir('win32', { LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local' })
    ).toBe('C:\\Users\\testuser\\AppData\\Local\\Blurt')
  })

  it('throws when LOCALAPPDATA is unset on win32', () => {
    expect(() => getRuntimeBaseDir('win32', {})).toThrow(/LOCALAPPDATA/)
  })

  it('joins HOME with Library/Application Support/Blurt on darwin', () => {
    expect(getRuntimeBaseDir('darwin', { HOME: '/Users/testuser' })).toBe(
      '/Users/testuser/Library/Application Support/Blurt'
    )
  })

  it('throws when HOME is unset on darwin', () => {
    expect(() => getRuntimeBaseDir('darwin', {})).toThrow(/HOME/)
  })

  it('throws a loud, explicit error for a platform this app does not manage a venv on', () => {
    expect(() => getRuntimeBaseDir('linux', { HOME: '/home/testuser' })).toThrow(
      /[Uu]nsupported platform/
    )
  })
})

describe('isVenvHealthy', () => {
  it('is false when the paths point nowhere real', () => {
    const paths = venvPathsFor('/definitely/not/a/real/path/venv', 'linux')
    expect(isVenvHealthy(paths)).toBe(false)
  })

  /**
   * Builds a venv-shaped directory: the interpreter and litert-lm script
   * that the old existence-only check was satisfied by, plus whatever marker
   * the caller asks for.
   */
  function makeVenv(marker?: string): ReturnType<typeof venvPathsFor> {
    const dir = mkdtempSync(join(tmpdir(), 'venv-health-'))
    const paths = venvPathsFor(dir, process.platform === 'win32' ? 'win32' : 'linux')
    mkdirSync(dirname(paths.pythonExe), { recursive: true })
    writeFileSync(paths.pythonExe, '')
    writeFileSync(paths.litertLmExe, '')
    if (marker !== undefined) {
      writeFileSync(join(dir, RUNTIME_MARKER_FILENAME), marker)
    }
    tempDirs.push(dir)
    return paths
  }

  const tempDirs: string[] = []
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  it('is true for a venv provisioned with exactly this build dependency set', () => {
    expect(isVenvHealthy(makeVenv(runtimeMarkerContents()))).toBe(true)
  })

  /**
   * The upgrade case, and the whole reason the marker exists. A venv built
   * by an older Blurt has both executables and is missing the packages a
   * newer one needs; judged on existence alone it passes, setup is skipped,
   * and dictation then fails on an import error inside the sidecar.
   */
  it('is false for a venv provisioned before a dependency was added', () => {
    expect(isVenvHealthy(makeVenv('litert-lm==0.14.0'))).toBe(false)
  })

  it('is false for a venv with no marker at all, however complete it looks', () => {
    expect(isVenvHealthy(makeVenv())).toBe(false)
  })

  /** Setup writes the marker last, so a truncated one means the install died partway. */
  it('is false for a half-written marker', () => {
    const partial = runtimeMarkerContents().slice(0, 10)
    expect(isVenvHealthy(makeVenv(partial))).toBe(false)
  })

  it('tolerates trailing-whitespace differences, which say nothing about what is installed', () => {
    expect(isVenvHealthy(makeVenv(`${runtimeMarkerContents()}\n`))).toBe(true)
  })

  /** The recogniser cannot run without these, so dropping one must invalidate the venv. */
  it('requires the speech-recogniser packages to be part of the recorded set', () => {
    for (const platform of ['win32', 'darwin'] as const) {
      const specs = runtimePipSpecs(platform)
      expect(specs.some((s) => s.startsWith('onnx-asr'))).toBe(true)
      expect(specs.some((s) => s.startsWith('numpy'))).toBe(true)
      expect(specs.some((s) => s.startsWith('litert-lm'))).toBe(true)
    }
  })

  /**
   * onnxruntime-directml is what puts the recogniser on the GPU, and it
   * exists only for Windows. Installing the stock build there would silently
   * drop every dictation onto the CPU; installing the DirectML build
   * anywhere else fails outright at pip. They also conflict, so exactly one
   * must ever appear.
   */
  it('picks the ONNX Runtime build that matches the platform, and only one', () => {
    const windows = runtimePipSpecs('win32')
    expect(windows.filter((s) => s.startsWith('onnxruntime')).length).toBe(1)
    expect(windows.some((s) => s.startsWith('onnxruntime-directml'))).toBe(true)

    const mac = runtimePipSpecs('darwin')
    expect(mac.filter((s) => s.startsWith('onnxruntime')).length).toBe(1)
    expect(mac.some((s) => s.startsWith('onnxruntime-directml'))).toBe(false)
  })

  /**
   * The marker records what was installed, so it has to differ per platform
   * - otherwise a venv provisioned on one would be judged healthy on the
   * other while carrying the wrong ONNX Runtime.
   */
  it('records a different marker per platform', () => {
    expect(runtimeMarkerContents('win32')).not.toBe(runtimeMarkerContents('darwin'))
  })
})
