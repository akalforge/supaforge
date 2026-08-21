import type { EnvironmentConfig, SupaForgeConfig } from '../types/config'
import type { DriftIssue, CheckName } from '../types/drift'

export interface CheckContext {
  /**
   * Optional sink for sub-check progress, e.g. the table counter emitted
   * during a long schema diff (issue #29). Checks that have nothing
   * fine-grained to report simply ignore it.
   */
  onDetail?: (detail: string) => void
  source: EnvironmentConfig
  target: EnvironmentConfig
  config: SupaForgeConfig
}

/**
 * Thrown by a check that cannot run — missing credentials, an absent
 * extension, nothing configured to compare.
 *
 * Checks used to signal this by returning `[]`, which is the same value a
 * genuinely clean scan returns. The distinction was lost before it reached the
 * scanner, so a layer that never ran rendered as a green zero-issue pass
 * (issue #42). Throwing keeps `scan()` returning plain issues while giving the
 * scanner something it cannot mistake for a result.
 *
 * A skip is a normal outcome, not a failure: it carries no stack for the user
 * and is reported separately from errored checks.
 */
export class CheckSkipped extends Error {
  /** Distinguishes a skip from a genuine error across module boundaries. */
  override readonly name = 'CheckSkipped'

  constructor(reason: string) {
    super(reason)
  }
}

/**
 * Name-based rather than `instanceof`, which fails when two copies of the
 * module are loaded — a real possibility with bundled output and linked
 * packages.
 */
export function isCheckSkipped(err: unknown): err is CheckSkipped {
  return err instanceof Error && err.name === 'CheckSkipped'
}

export abstract class Check {
  abstract readonly name: CheckName
  abstract scan(ctx: CheckContext): Promise<DriftIssue[]>
}
