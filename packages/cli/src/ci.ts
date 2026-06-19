import type { ScanResult, DriftIssue } from './types/drift.js'

export type FailOn = 'critical' | 'warning' | 'any'

/**
 * Format a DriftIssue as a GitHub Actions annotation line.
 * Spec: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#setting-a-notice-message
 */
export function formatAnnotation(issue: DriftIssue): string {
  const level   = issue.severity === 'critical' ? 'error' : 'warning'
  const title   = issue.title.replace(/,/g, '\\,')
  const message = issue.description
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
  return `::${level} title=${title}::${message}`
}

/** Emit all drift issues as GitHub Actions annotation lines. */
export function formatGitHubAnnotations(result: ScanResult): string[] {
  const lines: string[] = []
  for (const check of result.checks) {
    for (const issue of check.issues) {
      lines.push(formatAnnotation(issue))
    }
  }
  return lines
}

/**
 * Determine the exit code for CI.
 *
 * 0 = no drift above threshold
 * 1 = drift exceeds threshold
 * 2 = scan error (connection failure, etc.)
 */
export function computeCiExitCode(result: ScanResult, failOn: FailOn = 'critical'): number {
  const hasError = result.checks.some(c => c.status === 'error')
  if (hasError) return 2

  if (failOn === 'critical' && result.summary.critical > 0) return 1
  if (failOn === 'warning' && (result.summary.critical > 0 || result.summary.warning > 0)) return 1
  if (failOn === 'any' && result.summary.total > 0) return 1

  return 0
}

/**
 * Produce a structured CI summary object for GitHub Actions step summaries
 * or artifact upload.
 */
export function formatCiSummary(result: ScanResult): {
  timestamp: string
  score: number
  summary: ScanResult['summary']
  criticalIssues: Array<{ check: string; id: string; title: string }>
  warningIssues: Array<{ check: string; id: string; title: string }>
} {
  const criticalIssues: Array<{ check: string; id: string; title: string }> = []
  const warningIssues:  Array<{ check: string; id: string; title: string }> = []

  for (const check of result.checks) {
    for (const issue of check.issues) {
      const entry = { check: check.check, id: issue.id, title: issue.title }
      if (issue.severity === 'critical') {
        criticalIssues.push(entry)
      } else if (issue.severity === 'warning') {
        warningIssues.push(entry)
      }
    }
  }

  return {
    timestamp: result.timestamp,
    score: result.score,
    summary: result.summary,
    criticalIssues,
    warningIssues,
  }
}
