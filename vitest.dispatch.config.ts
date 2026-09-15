import path from 'node:path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/dispatch/**/*.integration.test.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
    setupFiles: ['__tests__/dispatch/harness.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'vendor/scrum4me-shared/lib'),
    },
  },
})
