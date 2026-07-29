import { defineConfig } from 'vitest/config'

// Deliberately separate from electron.vite.config.ts - these are plain
// node-environment unit tests for pure logic modules (litertWire.ts and
// friends), not part of the electron-vite main/preload/renderer build.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts']
  }
})
