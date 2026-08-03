import { resolve } from 'path'
import { defineConfig } from 'vitest/config'

// Deliberately separate from electron.vite.config.ts - these are plain
// node-environment unit tests for pure logic modules (litertWire.ts and
// friends), not part of the electron-vite main/preload/renderer build.
export default defineConfig({
  // electron.vite.config.ts defines this alias for all three targets, so any
  // module that imports '@shared/...' at RUNTIME (as opposed to `import
  // type`, which is erased) could not be pulled into a test at all - the
  // import simply failed to resolve here. That quietly ruled out testing
  // every screen and most components, since they reach @shared through
  // lib/format.ts and friends, and the limitation was invisible: nothing
  // failed, the tests just could not be written in the first place.
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
