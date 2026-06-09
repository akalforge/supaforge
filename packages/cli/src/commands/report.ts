import { Flags } from '@oclif/core'
import { createInterface } from 'node:readline/promises'
import { BaseCommand } from '../base-command.js'
import { readRunLog, runLogPath, type RunLogEntry } from '../run-log.js'
import { ok, dim, bold, warn, cmd } from '../ui.js'
import { sanitizeForReport } from '../utils/sanitize.js'

const REPORT_ENDPOINT =
  process.env['SUPAFORGE_REPORT_URL'] ?? 'https://supaforge.dev/api/bug-reports'
const PRIVACY_URL = 'https://supaforge.dev/privacy'
const DATA_RETENTION_DAYS = 90

/**
 * Display recent supaforge command history from the local run log.
 *
 * With --send: interactively select entries to send as anonymous bug reports.
 * The user sees exactly what data will be transmitted before confirming.
 * No SQL, table names, schema content, or identifying information is ever sent.
 */
export default class Report extends BaseCommand {
  static override description = 'Show recent supaforge command history from the local run log'

  static override examples = [
    '<%= config.bin %> report',
    '<%= config.bin %> report --last=20',
    '<%= config.bin %> report --send',
    '<%= config.bin %> report --json',
  ]

  static override flags = {
    last: Flags.integer({
      char: 'n',
      description: 'Number of recent entries to show',
      default: 10,
    }),
    send: Flags.boolean({
      description: 'Interactively select entries to send as anonymous bug reports',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Report)
    const all = await readRunLog()
    const entries = all.slice(-flags.last)

    if (flags.json) {
      this.log(JSON.stringify(entries, null, 2))
      return
    }

    if (flags.send) {
      await this.sendFlow(entries)
      return
    }

    this.displayEntries(entries)
  }

  private displayEntries(entries: RunLogEntry[]): void {
    const logFile = runLogPath()

    if (entries.length === 0) {
      this.log(`\n  ${dim('No command history found.')}`)
      this.log(`  ${dim(`Log file: ${logFile}`)}`)
      this.log(`  ${dim('Run any supaforge command to start logging.')}\n`)
      return
    }

    this.log(`\n  ${bold(`Last ${entries.length} command(s)`)} ${dim(`· log: ${logFile}`)}\n`)

    for (const entry of entries) {
      const ts = new Date(entry.timestamp).toLocaleString()
      const dur = entry.durationMs < 1000
        ? `${entry.durationMs}ms`
        : `${(entry.durationMs / 1000).toFixed(1)}s`
      const icon = entry.exitStatus === 'success' ? ok('✓') : warn('✗')
      this.log(`  ${icon} ${bold(entry.command)} ${dim(entry.args.join(' '))}`)
      this.log(`    ${dim(`${ts} · ${dur}`)}`)
      if (entry.error) {
        this.log(`    ${warn(entry.error)}`)
      }
      if (entry.checkSummaries) {
        for (const c of entry.checkSummaries.filter(s => s.status === 'error' || s.issueCount > 0)) {
          const icon2 = c.status === 'error' ? warn('✗') : dim('●')
          const detail = c.status === 'error' ? warn(c.error ?? 'error') : `${c.issueCount} issues`
          this.log(`    ${icon2} ${dim(`[${c.check}]`)} ${detail}`)
        }
      }
      this.log('')
    }

    this.log(dim('  ──────────────────────────────────────────────────────────'))
    this.log(dim('  Data is stored only on this machine (~/.supaforge/run-log.jsonl).'))
    this.log(dim(`  To send a bug report: ${cmd('supaforge report --send')}`))
    this.log(dim('  To delete history: rm ~/.supaforge/run-log.jsonl\n'))
  }

  private async sendFlow(entries: RunLogEntry[]): Promise<void> {
    if (!process.stdin.isTTY) {
      this.error('--send requires an interactive terminal.')
    }

    if (entries.length === 0) {
      this.log(`\n  ${dim('No command history to send.')}\n`)
      return
    }

    this.log(`\n  ${bold('Recent commands')}\n`)
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]
      const ts = new Date(e.timestamp).toLocaleString()
      const dur = (e.durationMs / 1000).toFixed(1)
      const icon = e.exitStatus === 'success' ? ok('✓') : warn('✗')
      this.log(`  ${dim(`[${i + 1}]`)}  ${icon}  ${bold(e.command)} ${dim(e.args.join(' '))}  ${dim(`${ts} · ${dur}s`)}`)
      if (e.error) this.log(`         ${warn(e.error)}`)
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })

    let selected: number[]
    let confirmed = false

    try {
      const rawSelection = await rl.question(
        '\n  Enter numbers to send (e.g. 1,3 or all, or press Enter to cancel): '
      )

      if (!rawSelection.trim()) {
        this.log(`\n  ${dim('Cancelled.')}\n`)
        return
      }

      if (rawSelection.trim().toLowerCase() === 'all') {
        selected = entries.map((_, i) => i)
      } else {
        selected = rawSelection
          .split(',')
          .map(s => parseInt(s.trim(), 10) - 1)
          .filter(n => !isNaN(n) && n >= 0 && n < entries.length)
      }

      if (selected.length === 0) {
        this.log(`\n  ${dim('No valid entries selected. Cancelled.')}\n`)
        return
      }

      const payloads = selected.map(i => this.buildPayload(entries[i]))

      this.log(`\n  ${bold('Exactly this data will be sent')} ${dim('— nothing else:')}\n`)
      for (const payload of payloads) {
        const lines = JSON.stringify(payload, null, 4).split('\n')
        for (const line of lines) this.log(`  ${line}`)
        this.log('')
      }

      this.log(dim('  ──────────────────────────────────────────────────────────'))
      this.log(dim('  Included:  command name · duration · exit status · version'))
      this.log(dim('             per-check status and issue counts'))
      this.log(dim('             error messages (URLs and file paths redacted)'))
      this.log(dim('  Excluded:  SQL · table/column names · data values'))
      this.log(dim('             database URLs · file paths · IP addresses'))
      this.log(dim(`  Retention: deleted after ${DATA_RETENTION_DAYS} days  ·  ${PRIVACY_URL}`))
      this.log(dim('  ──────────────────────────────────────────────────────────\n'))

      const answer = await rl.question(`  Send ${selected.length} report(s)? [y/N] `)
      confirmed = answer.trim().toLowerCase() === 'y'
    } finally {
      rl.close()
    }

    if (!confirmed) {
      this.log(`\n  ${dim('Cancelled. Nothing was sent.')}\n`)
      return
    }

    const payloads = selected.map(i => this.buildPayload(entries[i]))

    this.log('')
    let sent = 0
    for (const payload of payloads) {
      try {
        const res = await fetch(REPORT_ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': `supaforge-cli/${payload.version ?? 'unknown'}` },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) {
          const body = await res.json() as { reportId?: string }
          this.log(`  ${ok('✓')} Sent${body.reportId ? `  ${dim(`ref: ${body.reportId}`)}` : ''}`)
          sent++
        } else {
          this.log(`  ${warn('✗')} Failed (HTTP ${res.status})`)
        }
      } catch {
        this.log(`  ${warn('✗')} Failed (network error — check your connection)`)
      }
    }

    this.log('')
    if (sent > 0) {
      this.log(dim(`  ${sent} report(s) sent. Thank you — this helps us fix bugs faster.\n`))
    }
  }

  private buildPayload(entry: RunLogEntry): Record<string, unknown> {
    return {
      command: entry.command,
      args: entry.args,
      durationMs: entry.durationMs,
      exitStatus: entry.exitStatus,
      ...(entry.error ? { error: sanitizeForReport(entry.error) } : {}),
      ...(entry.version ? { version: entry.version } : {}),
      ...(entry.checkSummaries?.length ? { checkSummaries: entry.checkSummaries } : {}),
    }
  }
}
