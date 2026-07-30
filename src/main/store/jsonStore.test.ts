import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { JsonStore } from './jsonStore'

interface Demo {
  name: string
  count: number
}

const DEFAULT: Demo = { name: 'default', count: 0 }

describe('JsonStore', () => {
  let dir: string
  let filePath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsonstore-test-'))
    filePath = join(dir, 'settings.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns the default value when the file does not exist', () => {
    const store = new JsonStore<Demo>(filePath, DEFAULT)
    expect(store.read()).toEqual(DEFAULT)
  })

  it('reads and merges plain UTF-8 JSON with no BOM', () => {
    writeFileSync(filePath, JSON.stringify({ name: 'hello' }), 'utf-8')
    const store = new JsonStore<Demo>(filePath, DEFAULT)
    expect(store.read()).toEqual({ name: 'hello', count: 0 })
  })

  it('strips a leading UTF-8 BOM before parsing (PowerShell 5.1 -Encoding UTF8 default)', () => {
    const bom = '﻿'
    writeFileSync(filePath, bom + JSON.stringify({ name: 'from-powershell' }), 'utf-8')
    const store = new JsonStore<Demo>(filePath, DEFAULT)
    expect(store.read()).toEqual({ name: 'from-powershell', count: 0 })
    // The file itself is left alone - only the in-memory read is BOM-tolerant.
    expect(readdirSync(dir)).toEqual(['settings.json'])
  })

  it('quarantines an invalid file and falls back to defaults, without repeating on the next read', () => {
    writeFileSync(filePath, '﻿{ "b"...garbage not json', 'utf-8')
    const store = new JsonStore<Demo>(filePath, DEFAULT)

    expect(store.read()).toEqual(DEFAULT)

    const entries = readdirSync(dir)
    const quarantined = entries.find((e) => e.startsWith('settings.json.invalid-'))
    expect(quarantined).toBeDefined()
    expect(entries).not.toContain('settings.json')

    // The bad content is preserved verbatim under the quarantined name.
    const preserved = readFileSync(join(dir, quarantined!), 'utf-8')
    expect(preserved).toContain('garbage not json')

    // Cached in-memory value keeps returning defaults without re-touching disk.
    expect(store.read()).toEqual(DEFAULT)
  })

  it('a fresh JsonStore after quarantine sees no file and uses defaults cleanly', () => {
    writeFileSync(filePath, 'not json at all', 'utf-8')
    new JsonStore<Demo>(filePath, DEFAULT).read()

    const entries = readdirSync(dir)
    expect(entries).not.toContain('settings.json')

    const freshStore = new JsonStore<Demo>(filePath, DEFAULT)
    expect(freshStore.read()).toEqual(DEFAULT)
  })

  it('write() persists values that read() (in a new instance) can read back, BOM-free', () => {
    const store = new JsonStore<Demo>(filePath, DEFAULT)
    store.write({ name: 'saved', count: 5 })

    const raw = readFileSync(filePath, 'utf-8')
    expect(raw.charCodeAt(0)).not.toBe(0xfeff)

    const reread = new JsonStore<Demo>(filePath, DEFAULT)
    expect(reread.read()).toEqual({ name: 'saved', count: 5 })
  })
})
