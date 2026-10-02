import { defineConfig } from 'vitest/config'

// Scenario suites: corpus-driven, against real servers, through the built CLI.
// Heavier than the unit suite, so they run in a job of their own rather than
// once per Node version — see .github/workflows/integration.yml.
export default defineConfig({
  test: {
    globals: true,
    include: ['test/scenarios/**/*.test.ts'],
    globalSetup: ['./test/scenarios/global-setup.ts'],
    // A skipped scenario is one that did not run: fail on it, see the reporter.
    reporters: ['default', './test/scenarios/no-skips-reporter.ts'],
    maxConcurrency: Number(process.env.SCENARIO_CONCURRENCY ?? 6),
    testTimeout: 600_000,
    hookTimeout: 300_000,
  },
})
