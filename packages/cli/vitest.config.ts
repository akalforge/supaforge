import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // Run by vitest.scenarios.config.ts, in a job of their own.
    exclude: ['test/scenarios/**', 'node_modules/**'],
  },
})
