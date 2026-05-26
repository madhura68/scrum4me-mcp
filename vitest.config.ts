import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/**/*.test.ts'],
    exclude: ['vendor/**', 'node_modules/**'],
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'vendor/scrum4me-shared/lib'),
    },
  },
})
