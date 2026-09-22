import type { CheckResult } from './types/drift'
import { isComparisonCheck } from './types/drift'
import { SCORE_PENALTY_CRITICAL, SCORE_PENALTY_WARNING, SCORE_PENALTY_INFO, SCORE_PENALTY_ERROR, SCORE_MAX } from './constants'

export function summarize(results: CheckResult[]): { total: number; critical: number; warning: number; info: number } {
  let total = 0
  let critical = 0
  let warning = 0
  let info = 0

  for (const r of results) {
    for (const issue of r.issues) {
      total++
      if (issue.severity === 'critical') critical++
      else if (issue.severity === 'warning') warning++
      else info++
    }
  }

  return { total, critical, warning, info }
}

/**
 * Severity counts split by what the finding is *about*.
 *
 * `summarize` totals everything, which is right for "how much did this scan
 * find" and wrong for any decision that depends on whether the environments
 * have diverged. The exit code is such a decision: gating on the combined
 * critical count meant two byte-identical environments still exited 1 whenever
 * the target carried a pre-existing RLS gap, so "these environments differ" and
 * "something about the target is imperfect" were indistinguishable to a script
 * (issue #66). The scores were separated for the same reason (issue #40); this
 * gives the exit code the same split.
 */
export function summarizeByKind(results: CheckResult[]): {
  drift: ReturnType<typeof summarize>
  posture: ReturnType<typeof summarize>
} {
  return {
    drift: summarize(results.filter(r => isComparisonCheck(r.check))),
    posture: summarize(results.filter(r => !isComparisonCheck(r.check))),
  }
}

/** Score a set of results on the shared penalty scale. */
function scoreOf(results: CheckResult[]): number {
  const { total, critical, warning } = summarize(results)
  const errorCount = results.filter(r => r.status === 'error').length
  if (total === 0 && errorCount === 0) return SCORE_MAX
  const penalty =
    critical * SCORE_PENALTY_CRITICAL +
    warning * SCORE_PENALTY_WARNING +
    (total - critical - warning) * SCORE_PENALTY_INFO +
    errorCount * SCORE_PENALTY_ERROR
  return Math.max(0, SCORE_MAX - penalty)
}

/**
 * Compute the drift score, 0–100.
 *
 * 100 = the two environments match. Critical issues penalise heavily, and an
 * errored check also penalises — we can't confirm that layer is clean.
 *
 * Counts the comparison checks only. RLS Coverage and Migration History report
 * on the target's own posture and fire identically whichever pair you diff, so
 * including them meant a diff of an environment against *itself* could never
 * reach 100 (issue #40). A project with any long-standing RLS gap scored 0 no
 * matter how well synchronised its environments were, which made the number
 * useless as a sync signal. Those findings are scored separately by
 * computePostureScore — they are not discarded.
 */
export function computeScore(results: CheckResult[]): number {
  return scoreOf(results.filter(r => isComparisonCheck(r.check)))
}

/**
 * Compute the posture score, 0–100, over the non-comparative checks.
 *
 * Returns null when none of them ran, so the caller can omit the line rather
 * than print a perfect score for something never measured.
 */
export function computePostureScore(results: CheckResult[]): number | null {
  const posture = results.filter(r => !isComparisonCheck(r.check))
  if (posture.length === 0) return null
  return scoreOf(posture)
}
