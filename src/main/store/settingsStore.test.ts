import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MANAGED_COMMAND_BY_ACCELERATOR } from '../../shared/types'
import { SettingsStore } from './settingsStore'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'eloquent-settings-test-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('SettingsStore migration', () => {
  it('flips a pre-existing cpu install to gpu and rewrites its unmodified default command template', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        modelId: 'gemma-4-e2b',
        mode: 'offline',
        backend: 'litert',
        sidecar: {
          mode: 'managed',
          managedCommand: MANAGED_COMMAND_BY_ACCELERATOR.cpu,
          externalUrl: 'http://127.0.0.1:9379',
          port: 9379
        },
        autoCopyOnCleanup: false,
        customVocabulary: [],
        hotkey: 'Ctrl+Shift+Space'
      })
    )

    const store = new SettingsStore(dir)
    const settings = store.get()

    expect(settings.sidecar.accelerator).toBe('gpu')
    expect(settings.sidecar.managedCommand).toBe(MANAGED_COMMAND_BY_ACCELERATOR.gpu)
    expect(settings.settingsVersion).toBe(1)
    // The rewrite must actually hit disk, not just the in-memory cache - a
    // regression here (DEFAULT_SETTINGS carrying settingsVersion, which
    // JsonStore's shallow-merge would silently backfill onto any file
    // missing the key) made migrate() a permanent no-op without this check.
    const onDisk = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf-8'))
    expect(onDisk.sidecar.accelerator).toBe('gpu')
    expect(onDisk.settingsVersion).toBe(1)
  })

  it('flips accelerator but leaves a hand-edited managedCommand alone', () => {
    writeFileSync(
      join(dir, 'settings.json'),
      JSON.stringify({
        modelId: 'gemma-4-e2b',
        mode: 'offline',
        backend: 'litert',
        sidecar: {
          mode: 'managed',
          managedCommand: 'litert-lm serve --host 127.0.0.1 --port {port} --cors-origin *',
          externalUrl: 'http://127.0.0.1:9379',
          port: 9379
        },
        autoCopyOnCleanup: false,
        customVocabulary: [],
        hotkey: 'Ctrl+Shift+Space'
      })
    )

    const settings = new SettingsStore(dir).get()

    expect(settings.sidecar.accelerator).toBe('gpu')
    expect(settings.sidecar.managedCommand).toBe(
      'litert-lm serve --host 127.0.0.1 --port {port} --cors-origin *'
    )
  })

  it('is a no-op for a fresh install (defaults are already gpu, still stamps the version)', () => {
    const settings = new SettingsStore(dir).get()

    expect(settings.sidecar.accelerator).toBe('gpu')
    expect(settings.settingsVersion).toBe(1)
  })

  it('does not touch an already-migrated file on a second load', () => {
    new SettingsStore(dir) // writes+stamps v1
    const before = readFileSync(join(dir, 'settings.json'), 'utf-8')

    new SettingsStore(dir)
    const after = readFileSync(join(dir, 'settings.json'), 'utf-8')

    expect(after).toBe(before)
  })
})
