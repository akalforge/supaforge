import type { ScanResult, CheckResult, DriftIssue } from './types/drift'
import { CHECK_META } from './types/drift'
import { CHECK_LINE_PADDING } from './constants'
import { ok, warn, dim, bold, c } from './ui'

export function renderSummary(result: ScanResult): string {
  const lines: string[] = ['']

  const noun = result.summary.total === 1 ? 'issue' : 'issues'
  const driftedCount = result.checks.filter(l => l.status === 'drifted').length
  const checkNoun = driftedCount === 1 ? 'check' : 'checks'

  lines.push(
    result.summary.total > 0
      ? `${bold('SupaForge scan complete:')} ${warn(`${result.summary.total} drift ${noun}`)} found across ${driftedCount} ${checkNoun}.`
      : `${bold('SupaForge scan complete:')} ${ok('no drift detected. ✓')}`,
  )
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
