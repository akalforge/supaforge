import type { ScanResult, CheckResult, DriftIssue } from './types/drift'
import { CHECK_META, isComparisonCheck } from './types/drift'
import { CHECK_LINE_PADDING } from './constants'
import { ok, warn, dim, bold, c } from './ui'

/**
 * Number of checks that failed to run.
 *
 * Defensive against a malformed or partial ScanResult — an older cached
 * report, or a hand-built object in a hook — where `checks` may be missing
 * or not an array. Reporting zero errored checks is the safe fallback for
 * rendering; it never invents an error that is not there.
 */
export function countErrored(result: Pick<ScanResult, 'checks'>): number {
  if (!Array.isArray(result?.checks)) return 0
  return result.checks.filter(c => c?.status === 'error').length
}

/**
 * Number of checks that declined to run.
 *
 * A skipped layer was rendered identically to a clean one, so fourteen green
 * ticks could mean eleven comparisons and three layers that never opened a
 * connection (issue #42). Same defensive handling as countErrored.
 */
export function countSkipped(result: Pick<ScanResult, 'checks'>): number {
  if (!Array.isArray(result?.checks)) return 0
  return result.checks.filter(c => c?.status === 'skipped').length
}

/**
 * How many checks actually compared the two environments, over how many were
 * attempted.
 *
 * Printed alongside the score so a perfect number cannot be read as full
 * coverage. Skipped and errored layers both measured nothing, so neither
 * counts toward the numerator.
 */
export function coverage(result: Pick<ScanResult, 'checks'>): { compared: number; total: number } {
  if (!Array.isArray(result?.checks)) return { compared: 0, total: 0 }
  const total = result.checks.length
  const compared = result.checks.filter(c => c?.status === 'clean' || c?.status === 'drifted').length
  return { compared, total }
}

/**
 * Split the issue counts by whether they represent drift between the two
 * environments or the target's own posture.
 *
 * RLS Coverage and Migration History fire identically whichever pair you diff,
 * so counting them as drift made "9 drift issues found" the headline for a
 * comparison that found none (issue #40).
 */
export function splitCounts(result: Pick<ScanResult, 'checks'>): { drift: number; posture: number } {
  if (!Array.isArray(result?.checks)) return { drift: 0, posture: 0 }
  let drift = 0
  let posture = 0
  for (const check of result.checks) {
    const count = check?.issues?.length ?? 0
    if (isComparisonCheck(check?.check)) drift += count
    else posture += count
  }
  return { drift, posture }
}

/** Colour a 0–100 score green / amber / red. */
function colorScore(score: number): string {
  let style: Parameters<typeof c>[0] = 'red'
  if (score >= 80) style = 'green'
  else if (score >= 50) style = 'yellow'
  return c(style, `${score}/100`)
}

interface HeadlineCounts {
  drift: number
  noun: string
  driftedCount: number
  checkNoun: string
  erroredCount: number
  erroredNoun: string
}

/**
 * The one-line verdict.
 *
 * Drift wins over an error, and an error wins over silence: a check that could
 * not run measured nothing, so "no drift detected" would be a claim the scan
 * never earned (issue #29).
 */
function formatHeadline(counts: HeadlineCounts): string {
  const prefix = bold('SupaForge scan complete:')
  if (counts.drift > 0) {
    return `${prefix} ${warn(`${counts.drift} drift ${counts.noun}`)} found across ${counts.driftedCount} ${counts.checkNoun}.`
  }
  if (counts.erroredCount > 0) {
    return `${prefix} ${warn(`${counts.erroredCount} ${counts.erroredNoun} could not complete`)} — drift is unknown.`
  }
  return `${prefix} ${ok('no drift detected. ✓')}`
}

export function renderSummary(result: ScanResult): string {
  const lines: string[] = ['']

  // Counted separately: a posture finding is real but is not a difference
  // between the two environments (issue #40).
  const { drift, posture } = splitCounts(result)
  const noun = drift === 1 ? 'issue' : 'issues'
  const postureNoun = posture === 1 ? 'finding' : 'findings'
  const driftedCount = result.checks.filter(l => l.status === 'drifted' && isComparisonCheck(l.check)).length
  const checkNoun = driftedCount === 1 ? 'check' : 'checks'

  // A check that errored measured nothing. Reporting that as "no drift
  // detected" told users the environments matched when in truth the
  // comparison never ran (issue #29).
  const erroredCount = countErrored(result)
  const erroredNoun = erroredCount === 1 ? 'check' : 'checks'

  // A skipped check measured nothing either. It is a normal outcome rather
  // than a failure, so it is reported separately from an error — but it must
  // never read as a comparison that passed (issue #42).
  const skippedCount = countSkipped(result)
  const skippedNoun = skippedCount === 1 ? 'check was' : 'checks were'

  lines.push(formatHeadline({ drift, noun, driftedCount, checkNoun, erroredCount, erroredNoun }))

  // Named as what they are, so they cannot be read as the environments having
  // diverged. They are reported and scored, just not as drift.
  if (posture > 0) {
    lines.push(dim(`${posture} posture ${postureNoun} (RLS coverage / migration history) — present regardless of which pair you diff.`))
  }

  if (skippedCount > 0) {
    lines.push(dim(`${skippedCount} ${skippedNoun} skipped — coverage is partial.`))
  }

  // Drift was found *and* something failed: say so, or the count reads as the
  // whole picture.
  if (drift > 0 && erroredCount > 0) {
    lines.push(warn(`${erroredCount} further ${erroredNoun} could not complete — drift may be understated.`))
  }
  lines.push(`${dim('Source:')} ${result.source} ${dim('→')} ${dim('Target:')} ${result.target}`)
  lines.push('')

  for (const lr of result.checks) {
    lines.push(formatCheckLine(lr))
  }

  lines.push('')
  // The denominator the score was computed over, so 100/100 across a partial
  // run cannot be mistaken for a full comparison (issue #42).
  const { compared, total } = coverage(result)
  const coverageNote = compared === total ? '' : dim(` (${compared} of ${total} checks compared)`)
  lines.push(`${dim('Drift score:')} ${colorScore(result.score)}${coverageNote}`)

  if (result.postureScore !== null && result.postureScore !== undefined) {
    lines.push(`${dim('Posture score:')} ${colorScore(result.postureScore)}${dim(' (target only — RLS coverage, migration history)')}`)
  }
  lines.push('')

  return lines.join('\n')
}

export function renderDetailed(result: ScanResult): string {
  const lines = [renderSummary(result)]

  // Surface errored checks first — a check that couldn't run is more important
  // to see than the drift it failed to measure. Without this they only appeared
  // as a one-line "(error: ...)" in the summary with no detail or remediation.
  for (const lr of result.checks) {
    if (lr.status !== 'error') continue
    lines.push(formatErroredCheck(lr))
  }

  for (const lr of result.checks) {
    if (lr.issues.length === 0) continue
    const meta = CHECK_META[lr.check]
    lines.push(dim(`${'─'.repeat(2)} Layer ${meta.number}: ${meta.label} ${'─'.repeat(40)}`))
    lines.push('')

    for (const issue of lr.issues) {
      lines.push(formatIssue(issue))
    }
  }

  return lines.join('\n')
}

function formatErroredCheck(lr: CheckResult): string {
  const meta = CHECK_META[lr.check]
  const lines: string[] = []
  lines.push(c('red', `── Layer ${meta.number}: ${meta.label} — could not run ${'─'.repeat(28)}`))
  lines.push('')
  lines.push(`  ${c('red', '✖')} ${bold('Check failed — drift for this layer is unknown')}`)
  const errText = lr.error || 'check failed (no error message captured)'
  for (const line of errText.split('\n')) {
    lines.push(`    ${dim(line)}`)
  }
  lines.push('')
  lines.push(`    ${dim('This layer was skipped in the totals above. Fix the error and re-run to')}`)
  lines.push(`    ${dim('measure its drift; the score treats an errored check as unverified.')}`)
  lines.push('')
  return lines.join('\n')
}

function formatCheckLine(lr: CheckResult): string {
  const meta = CHECK_META[lr.check]
  const icon = statusIcon(lr.status)
  const prefix = `  ${icon} Layer ${meta.number} (${meta.label}):`

  // "0 issues" is the wrong thing to print for a layer that never ran — it is
  // the exact text a clean comparison produces (issue #42). Reuses the
  // `skipped — reason` form `snapshot` already uses for the same situation.
  if (lr.status === 'skipped') {
    const reason = lr.skipReason ? ` — ${lr.skipReason}` : ''
    return `${prefix.padEnd(CHECK_LINE_PADDING)}${dim(`skipped${reason}`)}`
  }

  const count = lr.issues.length
  const noun = count === 1 ? 'issue' : 'issues'
  const severity = highestSeverity(lr)
  const sevLabel = severity ? colorSeverity(severity) : ''
  const errText = lr.error || (lr.status === 'error' ? 'check failed' : '')
  const errLabel = errText ? `  ${warn(`(error: ${errText})`)}` : ''
  return `${prefix.padEnd(CHECK_LINE_PADDING)}${count} ${noun}${sevLabel}${errLabel}`
}

/** Glyph for an issue's severity. */
function severityIcon(severity: DriftIssue['severity']): string {
  switch (severity) {
    case 'critical': return c('red', '✖')
    case 'warning': return warn('⚠')
    default: return c('blue', 'ℹ')
  }
}

function formatIssue(issue: DriftIssue): string {
  const lines: string[] = []
  lines.push(`  ${severityIcon(issue.severity)} ${colorSeverity(issue.severity)} ${bold(issue.title)}`)
  lines.push(`    ${dim(issue.description)}`)

  if (issue.sql) {
    lines.push('')
    lines.push(`    ${dim('SQL fix (UP):')}`)
    for (const line of issue.sql.up.split('\n')) {
      lines.push(`      ${c('cyan', line)}`)
    }
  } else if (issue.action) {
    lines.push('')
    lines.push(`    ${dim('API action:')} ${c('cyan', issue.action.label)}`)
  }

  lines.push('')
  return lines.join('\n')
}

function statusIcon(status: CheckResult['status']): string {
  switch (status) {
    case 'clean': return ok('✓')
    case 'drifted': return warn('●')
    case 'error': return c('red', '✖')
    case 'skipped': return dim('○')
  }
}

function colorSeverity(severity: string): string {
  switch (severity) {
    case 'critical': return c('red', `[${severity.toUpperCase()}]`)
    case 'warning': return warn(`[${severity.toUpperCase()}]`)
    case 'info': return c('blue', `[${severity.toUpperCase()}]`)
    default: return `[${severity.toUpperCase()}]`
  }
}

function highestSeverity(lr: CheckResult): string | null {
  if (lr.issues.some(i => i.severity === 'critical')) return 'critical'
  if (lr.issues.some(i => i.severity === 'warning')) return 'warning'
  if (lr.issues.some(i => i.severity === 'info')) return 'info'
  return null
}
