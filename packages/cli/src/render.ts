import type { ScanResult, CheckResult, DriftIssue } from './types/drift'
import { CHECK_META } from './types/drift'
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

export function renderSummary(result: ScanResult): string {
  const lines: string[] = ['']

  const noun = result.summary.total === 1 ? 'issue' : 'issues'
  const driftedCount = result.checks.filter(l => l.status === 'drifted').length
  const checkNoun = driftedCount === 1 ? 'check' : 'checks'

  // A check that errored measured nothing. Reporting that as "no drift
  // detected" told users the environments matched when in truth the
  // comparison never ran (issue #29).
  const erroredCount = countErrored(result)
  const erroredNoun = erroredCount === 1 ? 'check' : 'checks'

  if (result.summary.total > 0) {
    lines.push(
      `${bold('SupaForge scan complete:')} ${warn(`${result.summary.total} drift ${noun}`)} found across ${driftedCount} ${checkNoun}.`,
    )
  } else if (erroredCount > 0) {
    lines.push(
      `${bold('SupaForge scan complete:')} ${warn(`${erroredCount} ${erroredNoun} could not complete`)} — drift is unknown.`,
    )
  } else {
    lines.push(`${bold('SupaForge scan complete:')} ${ok('no drift detected. ✓')}`)
  }

  // Drift was found *and* something failed: say so, or the count reads as the
  // whole picture.
  if (result.summary.total > 0 && erroredCount > 0) {
    lines.push(warn(`${erroredCount} further ${erroredNoun} could not complete — drift may be understated.`))
  }
  lines.push(`${dim('Source:')} ${result.source} ${dim('→')} ${dim('Target:')} ${result.target}`)
  lines.push('')

  for (const lr of result.checks) {
    lines.push(formatCheckLine(lr))
  }

  lines.push('')
  const scoreColor = result.score >= 80 ? 'green' : result.score >= 50 ? 'yellow' : 'red'
  lines.push(`${dim('Drift score:')} ${c(scoreColor as Parameters<typeof c>[0], `${result.score}/100`)}`)
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
  const count = lr.issues.length
  const noun = count === 1 ? 'issue' : 'issues'
  const severity = highestSeverity(lr)
  const sevLabel = severity ? colorSeverity(severity) : ''
  const errText = lr.error || (lr.status === 'error' ? 'check failed' : '')
  const errLabel = errText ? `  ${warn(`(error: ${errText})`)}` : ''
  const prefix = `  ${icon} Layer ${meta.number} (${meta.label}):`
  return `${prefix.padEnd(CHECK_LINE_PADDING)}${count} ${noun}${sevLabel}${errLabel}`
}

function formatIssue(issue: DriftIssue): string {
  const lines: string[] = []
  const sevIcon = issue.severity === 'critical' ? c('red', '✖') : issue.severity === 'warning' ? warn('⚠') : c('blue', 'ℹ')
  lines.push(`  ${sevIcon} ${colorSeverity(issue.severity)} ${bold(issue.title)}`)
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
