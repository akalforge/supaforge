import type { ScanResult, DriftIssue } from './types/drift.js'
import { coverage } from './render.js'

export type FailOn = 'critical' | 'warning' | 'any'

/**
 * Escape a workflow-command *message* (the text after `::`).
 *
 * GitHub Actions uses percent-encoding, not backslash escaping. `%` must be
 * encoded first so the percent signs introduced by the other replacements are
 * not double-encoded. Mirrors `@actions/core`'s `escapeData`.
 */
function escapeData(value: string): string {
  return value
    .replace(/%/g, '%25')
    .replace(/\r/g, '%0D')
    .replace(/\n/g, '%0A')
}

/**
 * Escape a workflow-command *property* value (e.g. `title=`). In addition to
 * the message escapes, `:` and `,` must be encoded because they delimit
 * properties. Mirrors `@actions/core`'s `escapeProperty`.
 */
function escapeProperty(value: string): string {
  return escapeData(value)
    .replace(/:/g, '%3A')
    .replace(/,/g, '%2C')
}

/**
 * Format a DriftIssue as a GitHub Actions annotation line.
 * Spec: https://docs.github.com/en/actions/writing-workflows/choosing-what-your-workflow-does/workflow-commands-for-github-actions#setting-a-notice-message
 */
export function formatAnnotation(issue: DriftIssue): string {
  const level   = issue.severity === 'critical' ? 'error' : 'warning'
  const title   = escapeProperty(issue.title)
  const message = escapeData(issue.description)
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
  /**
   * Checks that failed to run. Empty on a healthy scan.
   *
   * Without this a reader of the uploaded artifact saw only a clean summary
   * and had no way to tell that a check never ran — the exit code carried
   * that signal, but the artifact did not (issue #29).
   */
  errors: Array<{ check: string; message: string }>
  /**
   * Checks that declined to run, with the reason.
   *
   * A skipped check is not a failure, so it does not belong in `errors` — but
   * omitting it entirely left a CI artifact that read as full coverage when
   * three layers had never opened a connection (issue #42).
   */
  skipped: Array<{ check: string; reason: string }>
  /** How many checks compared the two environments, over how many were attempted. */
  coverage: { compared: number; total: number }
  criticalIssues: Array<{ check: string; id: string; title: string }>
  warningIssues: Array<{ check: string; id: string; title: string }>
} {
  const criticalIssues: Array<{ check: string; id: string; title: string }> = []
  const warningIssues:  Array<{ check: string; id: string; title: string }> = []
  const errors: Array<{ check: string; message: string }> = []
  const skipped: Array<{ check: string; reason: string }> = []

  for (const check of result.checks ?? []) {
    if (check?.status === 'error') {
      errors.push({ check: check.check, message: check.error ?? 'Check failed with no error message' })
    }
    if (check?.status === 'skipped') {
      skipped.push({ check: check.check, reason: check.skipReason ?? 'no reason given' })
    }
    for (const issue of check?.issues ?? []) {
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
    errors,
    skipped,
    coverage: coverage(result),
    criticalIssues,
    warningIssues,
  }
}
