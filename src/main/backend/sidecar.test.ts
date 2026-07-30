import { describe, expect, it } from 'vitest'
import {
  buildManagedChildEnv,
  commandReferencesServeGpuWrapper,
  parseEffectiveBackendLine,
  PARENT_PID_ENV_VAR,
  renderManagedCommand,
  resolveImportCli,
  tokenizeCommand
} from './sidecar'

describe('parseEffectiveBackendLine', () => {
  it('parses the gpu marker', () => {
    expect(parseEffectiveBackendLine('ELOQUENT_EFFECTIVE_BACKEND=gpu')).toBe('gpu')
  })

  it('parses the cpu marker', () => {
    expect(parseEffectiveBackendLine('ELOQUENT_EFFECTIVE_BACKEND=cpu')).toBe('cpu')
  })

  it('tolerates trailing whitespace/carriage returns', () => {
    expect(parseEffectiveBackendLine('ELOQUENT_EFFECTIVE_BACKEND=gpu\r')).toBe('gpu')
  })

  it('returns null for unrelated log lines', () => {
    expect(
      parseEffectiveBackendLine('Starting OpenAI-compatible API server on 127.0.0.1:9379...')
    ).toBeNull()
    expect(parseEffectiveBackendLine('')).toBeNull()
    expect(parseEffectiveBackendLine('ELOQUENT_EFFECTIVE_BACKEND=npu')).toBeNull()
  })
})

describe('buildManagedChildEnv', () => {
  it('sets PARENT_PID_ENV_VAR from parentPid on top of the base env', () => {
    const env = buildManagedChildEnv({ PATH: '/usr/bin' }, undefined, 4242)
    expect(env).toEqual({ PATH: '/usr/bin', [PARENT_PID_ENV_VAR]: '4242' })
  })

  it('merges caller-supplied extraEnv over the base env', () => {
    const env = buildManagedChildEnv({ PATH: '/usr/bin', FOO: 'base' }, { FOO: 'override' }, 1)
    expect(env.FOO).toBe('override')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('never lets extraEnv shadow the parent pid, even if it sets the same key', () => {
    const env = buildManagedChildEnv({}, { [PARENT_PID_ENV_VAR]: 'bogus' }, 999)
    expect(env[PARENT_PID_ENV_VAR]).toBe('999')
  })

  it('stringifies the pid (env values must be strings)', () => {
    const env = buildManagedChildEnv({}, undefined, 12345)
    expect(env[PARENT_PID_ENV_VAR]).toBe('12345')
  })
})

describe('tokenizeCommand', () => {
  it('splits on whitespace', () => {
    expect(tokenizeCommand('litert-lm serve --port 8765')).toEqual([
      'litert-lm',
      'serve',
      '--port',
      '8765'
    ])
  })

  it('respects double-quoted segments containing spaces', () => {
    expect(tokenizeCommand('litert-lm serve --model "C:\\my models\\gemma.litertlm"')).toEqual([
      'litert-lm',
      'serve',
      '--model',
      'C:\\my models\\gemma.litertlm'
    ])
  })

  it('respects single-quoted segments', () => {
    expect(tokenizeCommand("cmd --flag 'value with spaces'")).toEqual([
      'cmd',
      '--flag',
      'value with spaces'
    ])
  })
})

describe('renderManagedCommand', () => {
  it('substitutes {modelPath} and {port} before tokenizing', () => {
    const args = renderManagedCommand('litert-lm serve --model {modelPath} --port {port}', {
      modelPath: '/models/gemma-4-e2b.litertlm',
      port: 8765
    })
    expect(args).toEqual([
      'litert-lm',
      'serve',
      '--model',
      '/models/gemma-4-e2b.litertlm',
      '--port',
      '8765'
    ])
  })

  it('substitutes a quoted {modelPath} containing spaces as one token', () => {
    const args = renderManagedCommand('litert-lm serve --model "{modelPath}" --port {port}', {
      modelPath: '/models/my model.litertlm',
      port: 9000
    })
    expect(args).toEqual([
      'litert-lm',
      'serve',
      '--model',
      '/models/my model.litertlm',
      '--port',
      '9000'
    ])
  })

  it('substitutes {wrapperPath} (used by the GPU accelerator default template)', () => {
    const args = renderManagedCommand('python "{wrapperPath}" serve --port {port}', {
      modelPath: '',
      port: 9379,
      wrapperPath: '/app/resources/serve_gpu.py'
    })
    expect(args).toEqual(['python', '/app/resources/serve_gpu.py', 'serve', '--port', '9379'])
  })

  it('substitutes {wrapperPath} with an empty string when not provided', () => {
    const args = renderManagedCommand('litert-lm serve --model {modelPath} --port {port}', {
      modelPath: '/models/gemma-4-e2b.litertlm',
      port: 8765
    })
    expect(args).toEqual([
      'litert-lm',
      'serve',
      '--model',
      '/models/gemma-4-e2b.litertlm',
      '--port',
      '8765'
    ])
  })
})

describe('commandReferencesServeGpuWrapper', () => {
  it('is true for the GPU accelerator template rendered with a Windows-style wrapper path', () => {
    const args = renderManagedCommand('python "{wrapperPath}" serve --port {port}', {
      modelPath: '',
      port: 9379,
      wrapperPath: 'C:\\WindowsEloquent\\app\\resources\\serve_gpu.py'
    })
    expect(commandReferencesServeGpuWrapper(args)).toBe(true)
  })

  it('is true for a posix-style wrapper path', () => {
    const args = renderManagedCommand('python "{wrapperPath}" serve --port {port}', {
      modelPath: '',
      port: 9379,
      wrapperPath: '/repo/resources/serve_gpu.py'
    })
    expect(commandReferencesServeGpuWrapper(args)).toBe(true)
  })

  it('is false for the plain cpu accelerator template (no wrapper at all)', () => {
    const args = renderManagedCommand('litert-lm serve --host 127.0.0.1 --port {port}', {
      modelPath: '',
      port: 9379
    })
    expect(commandReferencesServeGpuWrapper(args)).toBe(false)
  })

  it('is false when {wrapperPath} was left unsubstituted (empty string)', () => {
    const args = renderManagedCommand('python "{wrapperPath}" serve --port {port}', {
      modelPath: '',
      port: 9379
    })
    expect(commandReferencesServeGpuWrapper(args)).toBe(false)
  })
})

describe('resolveImportCli', () => {
  it('resolves a bare litert-lm CLI as-is (the cpu accelerator template)', () => {
    expect(resolveImportCli('litert-lm serve --host 127.0.0.1 --port {port}')).toEqual({
      ok: true,
      cli: 'litert-lm'
    })
  })

  it('resolves an absolute litert-lm CLI path (with .exe) as-is', () => {
    expect(
      resolveImportCli('C:\\WindowsEloquent\\venv\\Scripts\\litert-lm.exe serve --port {port}')
    ).toEqual({ ok: true, cli: 'C:\\WindowsEloquent\\venv\\Scripts\\litert-lm.exe' })
  })

  it('resolves the sibling litert-lm.exe from an absolute win32 venv python path', () => {
    const result = resolveImportCli(
      'C:\\Users\\modte\\AppData\\Local\\WindowsEloquent\\venv\\Scripts\\python.exe "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose'
    )
    expect(result).toEqual({
      ok: true,
      cli: 'C:\\Users\\modte\\AppData\\Local\\WindowsEloquent\\venv\\Scripts\\litert-lm.exe'
    })
  })

  it('resolves the sibling bin/litert-lm from an absolute posix venv python path', () => {
    const result = resolveImportCli(
      '/home/user/.cache/windows-eloquent/venv/bin/python3.11 "{wrapperPath}" serve --port {port}'
    )
    expect(result).toEqual({
      ok: true,
      cli: '/home/user/.cache/windows-eloquent/venv/bin/litert-lm'
    })
  })

  it('resolves correctly from a full wrapper-style managed command template, ignoring the extra args', () => {
    const result = resolveImportCli(
      '"C:\\WindowsEloquent\\venv\\Scripts\\python.exe" "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose'
    )
    expect(result).toEqual({
      ok: true,
      cli: 'C:\\WindowsEloquent\\venv\\Scripts\\litert-lm.exe'
    })
  })

  it('hard-errors on a bare "python" with no directory component (the actual bug: PATH resolution is nondeterministic)', () => {
    const result = resolveImportCli(
      'python "{wrapperPath}" serve --host 127.0.0.1 --port {port} --verbose'
    )
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/bare Python interpreter/i)
    expect(result.ok === false && result.error).toMatch(/nondeterministic/i)
  })

  it('hard-errors on an unrecognized binary', () => {
    const result = resolveImportCli('my-custom-server.exe --port {port}')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/Can't derive the litert-lm import CLI/i)
  })

  it('hard-errors on an empty managed command', () => {
    const result = resolveImportCli('   ')
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/empty/i)
  })

  it('hard-errors on a python interpreter path with no venv Scripts/bin ancestor', () => {
    const result = resolveImportCli('python.exe serve --port {port}')
    // Bare name (no directory) still hits the "bare interpreter" branch, not this one -
    // exercise the "has one directory level but not two" case explicitly instead.
    expect(result.ok).toBe(false)

    const shallow = resolveImportCli('C:\\python.exe serve --port {port}')
    expect(shallow.ok).toBe(false)
    expect(shallow.ok === false && shallow.error).toMatch(/venv's Scripts\/bin directory/i)
  })
})
