import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { createDefaultRegistry } from '../checks/index.js'
import { scan } from '../scanner.js'
import type { ScanProgressEvent } from '../scanner.js'
import { renderSummary, renderDetailed } from '../render.js'
import { promote } from '../promote.js'
import type { CheckName } from '../types/drift.js'
import { CHECK_NAMES, CHECK_META } from '../types/drift.js'
import { ok, warn, dim, cmd } from '../ui.js'
import { sanitizeForReport } from '../utils/sanitize.js'
import { renderTip } from '../tips.js'
import { formatGitHubAnnotations, computeCiExitCode, formatCiSummary, type FailOn } from '../ci.js'

/**
 * Unified drift detection & resolution command.
 *
 * Default:   summary of what's drifted (was: scan)
 * --detail:  full SQL diffs (was: diff)
 * --apply:   fix the drift (was: promote)
 * --ci:      emit GitHub Actions annotations + structured exit codes
 */
export default class Diff extends BaseCommand {
  static override description = 'Detect drift between Supabase environments and optionally fix it'

  static override examples = [
    '<%= config.bin %> diff',
    '<%= config.bin %> diff --detail',
    '<%= config.bin %> diff --apply',
    '<%= config.bin %> diff --check=rls',
    '<%= config.bin %> diff --check=rls --apply',
    '<%= config.bin %> diff --source=staging --target=production',
    '<%= config.bin %> diff --skip=storage --skip=vault',
    '<%= config.bin %> diff --skip=auth --skip=edge-functions --skip=realtime',
    '<%= config.bin %> diff --ci',
    '<%= config.bin %> diff --ci --fail-on=warning',
  ]

  static override flags = {
    check: Flags.string({
      char: 'l',
      description: 'Limit to a specific check',
      options: [...CHECK_NAMES],
    }),
    skip: Flags.string({
      char: 'x',
      description: 'Skip a specific check (repeatable). Also configurable via checks.exclude in supaforge.config.json.',
      options: [...CHECK_NAMES],
      multiple: true,
    }),
    detail: Flags.boolean({
      description: 'Show detailed SQL diffs (default: summary)',
      default: false,
    }),
    apply: Flags.boolean({
      description: 'Apply SQL fixes to resolve drift in the target environment',
      default: false,
    }),
    'include-files': Flags.boolean({
      description: 'Include file-level drift detection in storage check',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
    ci: Flags.boolean({
      description: 'CI mode: emit GitHub Actions annotations and use semantic exit codes (0=clean, 1=drift, 2=error)',
      default: false,
    }),
    'fail-on': Flags.string({
      description: 'Threshold for a non-zero exit in CI mode',
      options: ['critical', 'warning', 'any'],
      default: 'critical',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Diff)

    const config = await this.loadConfigOrFail()
    this.validateDualEnvConfig(config, flags.source, flags.target)

    const registry = createDefaultRegistry({ includeFiles: flags['include-files'] })
    const checks = flags.check ? [flags.check as CheckName] : undefined
    const skip = flags.skip?.length ? (flags.skip as CheckName[]) : undefined

    // ── Preflight: verify both databases are reachable ────────────────────────
    if (!flags.json && !flags.ci) {
      const sourceEnv = config.environments[config.source!]
      const targetEnv = config.environments[config.target!]
      const pre = this.createPreflight('Diff preflight checks')
        .addDatabase('Source', config.source!, sourceEnv.dbUrl)
        .addDatabase('Target', config.target!, targetEnv.dbUrl)
      await this.runPreflight(pre, 'Diff')
    }

    /** Build a progress callback for scan calls. Only active when not --json or --ci. */
    const makeProgress = (): ((event: ScanProgressEvent) => void) | undefined => {
      if (flags.json || flags.ci) return undefined
      process.stdout.write('\n  Scanning...\n')
      return (event: ScanProgressEvent) => {
        const meta = CHECK_META[event.check]
        const label = meta?.label ?? event.check
        const idx = `[${event.index + 1}/${event.total}]`
        if (event.phase === 'check:start') {
          process.stdout.write(`  ▶ ${idx} ${label}...\n`)
        } else {
          const dur = `${(event.durationMs / 1000).toFixed(1)}s`
          const issues = event.status === 'error' ? warn('error')
            : event.status === 'skipped' ? dim('skipped')
            : `${event.issueCount} issues`
          process.stdout.write(`  ${ok('✓')} ${idx} ${label.padEnd(24)} ${issues}  (${dur})\n`)
        }
      }
    }

    // ── Apply mode (was: promote) ───────────────────────────────────────────────
    if (flags.apply) {
      const onProgress = makeProgress()
      const scanResult = await scan(registry, { config, checks, skip, onProgress })
      this.setCheckSummaries(scanResult.checks.map(c => ({
        check: c.check,
        status: c.status,
        issueCount: c.issues.length,
        durationMs: c.durationMs,
        ...(c.error ? { error: sanitizeForReport(c.error) } : {}),
      })))

      if (scanResult.summary.total === 0) {
        this.log(`${ok('No drift detected.')} Nothing to apply. ✓`)
        this.log(renderTip({ command: 'diff', apply: true, driftTotal: 0 }))
        return
      }

      const targetEnv = config.environments[config.target!]
      const result = await promote({
        dbUrl: targetEnv.dbUrl,
        scanResult,
        checks,
        dryRun: false,
      })

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2))
        return
      }

      if (result.applied.length > 0) {
        this.log(`${ok(`Applied ${result.applied.length} fix(es):`)}`)  
        for (const stmt of result.applied) {
          this.log(`  ${ok('✓')} ${dim(`[${stmt.check}]`)} ${stmt.issueId}`)
        }
      }

      if (result.skipped.length > 0) {
        this.log(`\n${dim(`Skipped ${result.skipped.length} issue(s):`)}`)  
        for (const item of result.skipped) {
          this.log(`  ${dim('○')} ${dim(`[${item.check}]`)} ${item.issueId}: ${item.reason}`)
        }
      }

      if (result.errors.length > 0) {
        this.log(`\n${warn(`${result.errors.length} error(s):`)}`)  
        for (const item of result.errors) {
          this.log(`  ${warn('✗')} ${dim(`[${item.check}]`)} ${item.issueId}: ${item.error}`)
        }
        this.exit(1)
      }

      this.log(renderTip({
        command: 'diff',
        apply: true,
        driftTotal: scanResult.summary.total,
        driftedChecks: scanResult.checks.filter(c => c.status === 'drifted').map(c => c.check),
      }))
      return
    }

    // ── Scan mode (summary, detail, CI, or JSON) ────────────────────────────
    const onProgress = makeProgress()
    const result = await scan(registry, { config, checks, skip, onProgress })
    this.setCheckSummaries(result.checks.map(c => ({
      check: c.check,
      status: c.status,
      issueCount: c.issues.length,
      durationMs: c.durationMs,
      ...(c.error ? { error: sanitizeForReport(c.error) } : {}),
    })))

    const driftedChecks = result.checks.filter(c => c.status === 'drifted').map(c => c.check)
    const skippedChecks = result.checks.filter(c => c.status === 'skipped').map(c => c.check)

    // ── CI mode ──────────────────────────────────────────────────────────────
    if (flags.ci) {
      const failOn = (flags['fail-on'] ?? 'critical') as FailOn
      const annotations = formatGitHubAnnotations(result)
      for (const line of annotations) {
        process.stdout.write(line + '\n')
      }
      const summary = formatCiSummary(result)
      process.stdout.write(JSON.stringify(summary, null, 2) + '\n')
      const exitCode = computeCiExitCode(result, failOn)
      if (exitCode !== 0) {
        this.exit(exitCode)
      }
      return
    }

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
    } else if (flags.detail) {
      this.log(renderDetailed(result))
      this.log(renderTip({
        command: 'diff',
        detail: true,
        driftTotal: result.summary.total,
        driftedChecks,
        skippedChecks,
        singleCheck: checks?.[0],
      }))
    } else {
      this.log(renderSummary(result))

      if (result.summary.total > 0) {
        this.log(`  → Run with ${cmd('--detail')} to see SQL diffs`)
        this.log(`  → Run with ${cmd('--apply')} to fix drift\n`)
      }

      this.log(renderTip({
        command: 'diff',
        detail: false,
        driftTotal: result.summary.total,
        driftedChecks,
        skippedChecks,
        singleCheck: checks?.[0],
      }))
    }

    if (result.summary.critical > 0) {
      this.exit(1)
    }
  }
}
