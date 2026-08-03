import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsStore } from './settingsStore'
import { DEFAULT_SETTINGS } from '../../shared/types'

/**
 * JsonStore fills in missing defaults exactly one level deep
 * (`{...defaults, ...parsed}`), so a nested object present in settings.json
 * replaces its default wholesale rather than being merged into it.
 *
 * The consequence is a quiet one: every key added to `pushToTalk` or
 * `sidecar` after a settings.json was written arrives as `undefined` for the
 * people who have been using Blurt longest, while reading correctly on a
 * fresh install. A new boolean is therefore off for them no matter what
 * DEFAULT_SETTINGS says, and its Settings toggle shows unchecked - which
 * looks exactly like a deliberate choice they made.
 */
describe('SettingsStore - defaults inside nested objects', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'settingsstore-test-'))
    filePath = join(dir, 'settings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  /** Writes a settings.json shaped like one from before a nested key existed. */
  function writeSettings(value: unknown): void {
    writeFileSync(filePath, JSON.stringify(value), 'utf-8')
  }

  it('fills in a pushToTalk key the stored file predates', () => {
    writeSettings({ pushToTalk: { enabled: true, key: 'AltRight', autoPaste: true } })
    const settings = new SettingsStore(dir).get()
    expect(settings.pushToTalk.trailingSpace).toBe(DEFAULT_SETTINGS.pushToTalk.trailingSpace)
  })

  it('keeps every value the user actually set', () => {
    writeSettings({ pushToTalk: { enabled: false, key: 'F9', autoPaste: false } })
    const settings = new SettingsStore(dir).get()
    expect(settings.pushToTalk.enabled).toBe(false)
    expect(settings.pushToTalk.key).toBe('F9')
    expect(settings.pushToTalk.autoPaste).toBe(false)
  })

  /**
   * The same hazard, and the one with teeth: `managedCommand` is the command
   * line Blurt spawns. Filling a gap must never mean overwriting one the
   * user (or a past version) wrote.
   */
  it('does not overwrite a sidecar command that is already there', () => {
    writeSettings({ sidecar: { mode: 'managed', managedCommand: 'my-own-litert-lm serve' } })
    const settings = new SettingsStore(dir).get()
    expect(settings.sidecar.managedCommand).toBe('my-own-litert-lm serve')
    expect(settings.sidecar.port).toBe(DEFAULT_SETTINGS.sidecar.port)
  })

  it('leaves a fresh install on the defaults', () => {
    const settings = new SettingsStore(dir).get()
    expect(settings.pushToTalk).toEqual(DEFAULT_SETTINGS.pushToTalk)
    expect(settings.sidecar).toEqual(DEFAULT_SETTINGS.sidecar)
  })

  /**
   * update() reads through get(), so the filled-in defaults are what gets
   * written back - otherwise an unrelated settings change would persist the
   * incomplete nested object all over again.
   */
  it('persists the filled-in defaults on the next write', () => {
    writeSettings({ pushToTalk: { enabled: true, key: 'AltRight', autoPaste: true } })
    const store = new SettingsStore(dir)
    store.update({ runInBackground: false })
    const onDisk = JSON.parse(readFileSync(filePath, 'utf-8'))
    expect(onDisk.pushToTalk.trailingSpace).toBe(DEFAULT_SETTINGS.pushToTalk.trailingSpace)
    expect(onDisk.runInBackground).toBe(false)
  })
})
