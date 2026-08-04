import { describe, expect, it, vi } from 'vitest'

/**
 * `registerModelManagerIpc` reaches for the real `ipcMain` singleton at
 * module scope, which does not exist outside a running Electron app. Mocked
 * here the same way overlayController.test.ts mocks `clipboard`, with
 * `handle` recording each channel's handler so a test can invoke one directly
 * and observe what it resolves (or rejects) with - which is the whole point
 * below, since "what does the renderer's `invoke` see" is exactly what these
 * tests are about.
 */
const handlers = new Map<string, (...args: unknown[]) => unknown>()
vi.mock('electron', () => ({
  BrowserWindow: class {},
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void => {
      handlers.set(channel, handler)
    }
  }
}))

import { IPC } from '../../shared/ipc-channels'
import type { ModelManager } from '../backend/modelManager'
import type { SettingsStore } from '../store/settingsStore'
import { registerModelManagerIpc } from './modelManagerIpc'

/** Minimal ModelManager stand-in: only the members the remove path actually touches. */
function fakeModelManager(remove: () => Promise<void>): ModelManager {
  return {
    listInstalled: () => [],
    getAllProgress: () => [],
    getModelsDir: () => '/tmp/blurt-test-models',
    cancelDownload: () => {},
    download: async () => {},
    remove,
    on: () => {}
  } as unknown as ModelManager
}

const fakeSettingsStore = {
  get: () => ({ sidecar: { managedCommand: 'litert-lm serve' } })
} as unknown as SettingsStore

function invokeRemove(): Promise<unknown> {
  const handler = handlers.get(IPC.models.remove)
  if (!handler) throw new Error('remove handler was never registered')
  return Promise.resolve(handler({}, 'gemma-4-e2b'))
}

describe('models:remove IPC', () => {
  it('waits for the deletion to finish before rebuilding the backend', async () => {
    // `remove()` is async - it retries the imported copy while the engine's
    // file handle closes - and this used to be called without `await`, so the
    // rebuild raced the retry loop instead of following it.
    const order: string[] = []
    const modelManager = fakeModelManager(async () => {
      order.push('remove:start')
      await new Promise((resolve) => setTimeout(resolve, 10))
      order.push('remove:end')
    })
    const backend = {
      releaseModelFiles: (): void => {
        order.push('release')
      },
      rebuild: async (): Promise<void> => {
        order.push('rebuild')
      }
    }

    registerModelManagerIpc(modelManager, fakeSettingsStore, () => null, undefined, backend)
    await invokeRemove()

    expect(order).toEqual(['release', 'remove:start', 'remove:end', 'rebuild'])
  })

  it('reports a failed deletion to the renderer instead of resolving as if it worked', async () => {
    // Deleting the downloaded file is a bare `unlinkSync`, which throws if
    // Windows still holds the file open. Unawaited, that rejection became an
    // unhandled promise rejection while this handler resolved normally - so
    // the renderer was told a deletion had happened that had not, which is
    // the exact silent failure ModelManager.remove's doc comment rules out.
    const modelManager = fakeModelManager(async () => {
      throw new Error('EPERM: operation not permitted, unlink model.litertlm')
    })
    let rebuilt = false
    const backend = {
      releaseModelFiles: (): void => {},
      rebuild: async (): Promise<void> => {
        rebuilt = true
      }
    }

    registerModelManagerIpc(modelManager, fakeSettingsStore, () => null, undefined, backend)

    await expect(invokeRemove()).rejects.toThrow('EPERM')
    // And it does not go on to rebuild a backend around a model whose
    // deletion just failed.
    expect(rebuilt).toBe(false)
  })
})
