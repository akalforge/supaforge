import type { ScanResult, CheckResult, DriftIssue } from './types/drift'
import { CHECK_META } from './types/drift'

export function renderSummary(result: ScanResult): string {
  const lines: string[] = ['']

  const noun = result.summary.total === 1 ? 'issue' : 'issues'
  const driftedCount = result.checks.filter(l => l.status === 'drifted').length
  const checkNoun = driftedCount === 1 ? 'check' : 'checks'

  lines.push(
    result.summary.total > 0
      ? `SupaForge scan complete: ${result.summary.total} drift ${noun} found across ${driftedCount} ${checkNoun}.`
      : 'SupaForge scan complete: no drift detected. ✓',
  )
  lines.push(`Source: ${result.source} → Target: ${result.target}`)
  lines.push('')

  for (const lr of result.checks) {
    lines.push(formatCheckLine(lr))
  }

  lines.push('')
  lines.push(`Drift score: ${result.score}/100`)
  lines.push('')

  return lines.join('\n')
}

export function renderDetailed(result: ScanResult): string {
  const lines = [renderSummary(result)]

  for (const lr of result.checks) {
    if (lr.issues.length === 0) continue
    const meta = CHECK_META[lr.check]
    lines.push(`${'─'.repeat(2)} Layer ${meta.number}: ${meta.label} ${'─'.repeat(40)}`)
    lines.push('')

    for (const issue of lr.issues) {
      lines.push(formatIssue(issue))
    }
  }

  return lines.join('\n')
}

function formatCheckLine(lr: CheckResult): string {
  const meta = CHECK_META[lr.check]
  const icon = statusIcon(lr.status)
  const count = lr.issues.length
  const noun = count === 1 ? 'issue' : 'issues'
  const severity = highestSeverity(lr)
  const sevLabel = severity ? `  [${severity.toUpperCase()}]` : ''
  const errLabel = lr.error ? `  (error: ${lr.error})` : ''
  const prefix = `  ${icon} Layer ${meta.number} (${meta.label}):`
  return `${prefix.padEnd(40)}${count} ${noun}${sevLabel}${errLabel}`
}

function formatIssue(issue: DriftIssue): string {
  const lines: string[] = []
  const sevIcon = issue.severity === 'critical' ? '✖' : issue.severity === 'warning' ? '⚠' : 'ℹ'
  lines.push(`  ${sevIcon} [${issue.severity.toUpperCase()}] ${issue.title}`)
  lines.push(`    ${issue.description}`)

  if (issue.sql) {
    lines.push('')
    lines.push('    SQL fix (UP):')
    for (const line of issue.sql.up.split('\n')) {
      lines.push(`      ${line}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}

function statusIcon(status: CheckResult['status']): string {
  switch (status) {
    case 'clean': return '✓'
    case 'drifted': return '●'
    case 'error': return '✖'
    case 'skipped': return '○'
  }
}

function highestSeverity(lr: CheckResult): string | null {
  if (lr.issues.some(i => i.severity === 'critical')) return 'critical'
  if (lr.issues.some(i => i.severity === 'warning')) return 'warning'
  if (lr.issues.some(i => i.severity === 'info')) return 'info'
  return null
}
