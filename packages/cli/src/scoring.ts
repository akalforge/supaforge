import type { CheckResult } from './types/drift'
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
 * Compute a drift health score from 0–100.
 * 100 = no drift. Critical issues penalise heavily.
 * Errored checks also penalise — we can't confirm the layer is clean.
 */
export function computeScore(results: CheckResult[]): number {
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
