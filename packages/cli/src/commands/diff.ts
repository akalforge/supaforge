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
 * Glyph and text for a finished check, so the three outcomes are visually
 * distinct in the live progress list.
 */
function describeCheckOutcome(
  status: 'clean' | 'drifted' | 'error' | 'skipped',
  issueCount: number,
  skipReason?: string,
): { glyph: string; text: string } {
  if (status === 'error') return { glyph: warn('✗'), text: warn('error') }
  if (status === 'skipped') {
    return { glyph: dim('○'), text: dim(`skipped — ${skipReason ?? 'no reason given'}`) }
  }
  return { glyph: ok('✓'), text: `${issueCount} issues` }
}

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

  /**
   * Read from the environment rather than passed as flags, because they tune
   * limits rather than select behaviour. Rendered as their own `--help`
   * section (issue #40); the README carries the same table plus the timeout
   * precedence chain.
   */
  static envVars = [
    { name: 'SUPAFORGE_CONNECT_TIMEOUT', description: 'Seconds before a database connection attempt is abandoned (default 15).' },
    { name: 'SUPAFORGE_DBDIFF_TIMEOUT', description: 'Seconds before the schema/data diff is abandoned. Overrides checks.schema.timeout (default 600).' },
    { name: 'SUPAFORGE_DBDIFF_MEMORY', description: "PHP memory limit for @dbdiff/cli — 512M, 2G, or -1 for unlimited (default dbdiff's own 1G)." },
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
    'allow-destructive': Flags.boolean({
      description: 'With --apply, also run fixes that drop tables or columns (destroys data)',
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
          // Clear any in-place detail line before the final result line.
          if (process.stdout.isTTY) process.stdout.write('\r\u001b[2K')
          const dur = `${(event.durationMs / 1000).toFixed(1)}s`
          // A skipped layer gets its own glyph and its reason. A green tick
          // beside "0 issues" was indistinguishable from a comparison that
          // passed (issue #42).
          const { glyph, text } = describeCheckOutcome(event.status, event.issueCount, event.skipReason)
          process.stdout.write(`  ${glyph} ${idx} ${label.padEnd(24)} ${text}  (${dur})\n`)
        }
      }
    }

    /**
     * Render fine-grained progress from within a check, in place.
     *
     * A ~100s schema diff on one static spinner line reads as a hang
     * (issue #29). Only used on a TTY — piped or CI output would otherwise
     * accumulate thousands of partial lines.
     */
    const makeDetail = (): ((check: CheckName, detail: string) => void) | undefined => {
      if (flags.json || flags.ci || !process.stdout.isTTY) return undefined
      return (_check, detail) => {
        process.stdout.write(`\r\u001b[2K    ${dim(detail)}`)
      }
    }

    // ── Apply mode (was: promote) ───────────────────────────────────────────────
    if (flags.apply) {
      const onProgress = makeProgress()
      const scanResult = await scan(registry, { config, checks, skip, onProgress, onDetail: makeDetail() })
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
        allowDestructive: flags['allow-destructive'],
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
    const result = await scan(registry, { config, checks, skip, onProgress, onDetail: makeDetail() })
    this.setCheckSummaries(result.checks.map(c => ({
      check: c.check,
      status: c.status,
      issueCount: c.issues.length,
      durationMs: c.durationMs,
      ...(c.error ? { error: sanitizeForReport(c.error) } : {}),
    })))

    const driftedChecks = result.checks.filter(c => c.status === 'drifted').map(c => c.check)
    const skippedChecks = result.checks.filter(c => c.status === 'skipped').map(c => c.check)
    // A check that errored measured nothing — surfaced so the summary and tips
    // never present an unmeasured scan as a clean one (issue #29).
    const erroredChecks = result.checks.filter(c => c.status === 'error').map(c => c.check)

    // ── CI mode ──────────────────────────────────────────────────────────────
    if (flags.ci) {
      const failOn = (flags['fail-on'] ?? 'critical') as FailOn
      // Annotations go to stderr; the machine-readable summary is the *only*
      // thing on stdout. This lets a workflow capture a clean JSON artifact
      // (`supaforge diff --ci > report.json`) while GitHub Actions still renders
      // the `::error`/`::warning` workflow commands from stderr.
      const annotations = formatGitHubAnnotations(result)
      for (const line of annotations) {
        process.stderr.write(line + '\n')
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
        erroredChecks,
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
        erroredChecks,
        singleCheck: checks?.[0],
      }))
    }

    // Exit code deliberately unchanged for an errored check: `--ci` is the
    // documented contract for scripting and already exits 2 in that case
    // (0=clean, 1=drift, 2=error). Making plain `diff` exit non-zero here
    // would break every non-CI caller for a signal that already has a
    // supported home. The misleading *output* is fixed above instead.
    if (result.summary.critical > 0) {
      this.exit(1)
    }
  }
}
