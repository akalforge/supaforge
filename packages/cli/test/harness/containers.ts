import { describe } from 'vitest'
import { PgHarness } from './PgHarness.js'

/**
 * `describe` for a suite that needs a container runtime.
 *
 * Without one the suite is skipped, so `npm test` still passes on a machine
 * with neither Podman nor Docker — except in CI. There a missing runtime is a
 * broken job, and skipping would turn it green having tested nothing, so it
 * fails instead.
 */
export function describeWithContainers(): typeof describe | typeof describe.skip {
  try {
    PgHarness.detectRuntime()
    return describe
  } catch (err) {
    if (process.env.CI) {
      throw new Error(`CI has no container runtime, so this suite cannot run: ${(err as Error).message}`)
    }
    return describe.skip
  }
}
