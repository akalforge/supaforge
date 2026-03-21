import type { LayerResult } from './types/drift'

export function summarize(results: LayerResult[]): { total: number; critical: number; warning: number; info: number } {
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
 */
export function computeScore(results: LayerResult[]): number {
  const { total, critical, warning } = summarize(results)
  if (total === 0) return 100
  const penalty = critical * 15 + warning * 5 + (total - critical - warning) * 1
  return Math.max(0, 100 - penalty)
}
