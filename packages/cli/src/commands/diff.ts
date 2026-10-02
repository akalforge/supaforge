import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { createDefaultRegistry } from '../checks/index.js'
import { scan } from '../scanner.js'
import type { ScanProgressEvent } from '../scanner.js'
import { renderSummary, renderDetailed, formatSkips } from '../render.js'
import { promote, planWork, type PromoteResult } from '../promote.js'
import type { CheckName, ScanResult } from '../types/drift.js'
import { CHECK_NAMES, CHECK_META } from '../types/drift.js'
import { ok, warn, dim, cmd, bold } from '../ui.js'
import { sanitizeForReport } from '../utils/sanitize.js'
import { renderTip } from '../tips.js'
import { formatGitHubAnnotations, computeCiExitCode, formatCiSummary, type FailOn } from '../ci.js'
import { resolveTableFilter, isFiltered, describeTableFilter } from '../utils/table-filter.js'
import { parseFlagList } from '../utils/strings.js'
import { isCloneDatabase, sourceLooksLikeCloneOf } from '../branch.js'
import { proveConvergence, residualHeldBack } from '../prove.js'
import { summarizeByKind } from '../scoring.js'
import { CLONE_SKIP_FLAGS } from '../defaults.js'

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
 * Flags that only mean something when fixes are being planned or executed.
 *
 * Passed on their own they used to be inert *and silent* — the run printed
 * byte-identical output to one with no flag at all. Worst for the two that read
 * as safety measures: someone reaching for `--prove` or `--dry-run` alone, the
 * natural instinct for "don't actually do it", got an ordinary diff and no sign
 * they had neither previewed nor proved anything (issue #71).
 *
 * `--dry-run` is deliberately absent: it now selects the planning path by
 * itself, so previewing never requires typing the flag that writes. Flags that
 * shape the *plan* rather than the execution are honoured under `--dry-run`, so
 * they are only inert when neither flag is present.
 */
const APPLY_ONLY_FLAGS: ReadonlyArray<{ flag: string; shapesThePlan: boolean }> = [
  { flag: 'prove', shapesThePlan: false },
  { flag: 'no-transaction', shapesThePlan: false },
  { flag: 'only', shapesThePlan: true },
  { flag: 'apply-posture', shapesThePlan: true },
  { flag: 'allow-destructive', shapesThePlan: true },
]

/** Which apply-only flags this invocation will silently ignore. */
export function inertApplyFlags(
  flags: Record<string, unknown>,
): ReadonlyArray<{ flag: string; shapesThePlan: boolean }> {
  if (flags['apply']) return []
  const dryRun = Boolean(flags['dry-run'])

  return APPLY_ONLY_FLAGS.filter(({ flag, shapesThePlan }) => {
    const given = flags[flag]
    const passed = Array.isArray(given) ? given.length > 0 : Boolean(given)
    if (!passed) return false
    return !(dryRun && shapesThePlan)
  })
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
    '<%= config.bin %> diff --tables=orders,order_items',
    "<%= config.bin %> diff --tables='billing_*' --exclude-tables='*_audit'",
    '<%= config.bin %> diff --tables=orders --detail',
    // Built from the same constant the tips and the post-clone output use, so
    // the advice cannot fall behind the check list again: this example predated
    // Layer 14 and omitted `roles`, which on a real clone → remote diff is 227
    // of the findings someone following it was left to puzzle over (issue #70).
    `<%= config.bin %> diff ${CLONE_SKIP_FLAGS}`,
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
    'dry-run': Flags.boolean({
      description: 'With --apply, print the fixes in the order they would run without executing any of them',
      default: false,
    }),
    'no-transaction': Flags.boolean({
      description: 'With --apply, run each fix on its own instead of rolling the whole set back on the first failure',
      aliases: ['continue-on-error'],
      default: false,
    }),
    only: Flags.string({
      description: 'With --apply, only apply these issue ids (repeatable, comma-separated, globs allowed). Ids come from --json.',
      multiple: true,
    }),
    'include-files': Flags.boolean({
      description: 'Include file-level drift detection in storage check',
      default: false,
    }),
    tables: Flags.string({
      description: 'Only compare these tables in the schema and data checks (repeatable, comma-separated, globs allowed). Overrides checks.tables.',
      multiple: true,
    }),
    'exclude-tables': Flags.string({
      description: 'Never compare these tables (repeatable, comma-separated, globs allowed). Merged with checks.excludeTables.',
      multiple: true,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
    ci: Flags.boolean({
      description: 'CI mode: emit GitHub Actions annotations and use semantic exit codes (0=clean, 1=drift, 2=error)',
      default: false,
    }),
    prove: Flags.boolean({
      description:
        'Before applying, replay the migration on a throwaway clone of the target '
        + 'and verify it reproduces the source exactly. Refuses to apply if it does not.',
      default: false,
    }),
    'apply-posture': Flags.boolean({
      description:
        'With --apply, also apply fixes from checks that judge the target on its own '
        + '(RLS coverage, migration history). Off by default: those fixes move the target '
        + 'away from the source and so create drift.',
      default: false,
    }),
    'fail-on': Flags.string({
      description: 'Threshold for a non-zero exit in CI mode',
      options: ['critical', 'warning', 'any'],
      default: 'critical',
    }),
    'fail-on-posture': Flags.boolean({
      description:
        'Let findings from the target-only checks (RLS coverage, migration history) '
        + 'affect the exit code too. Off by default: they fire identically whichever '
        + 'pair you diff, so they cannot indicate that the environments have diverged.',
      default: false,
    }),
  }

  /**
   * Report what `--apply` did, or — under `--dry-run` — what it would do.
   *
   * The applied list is printed in execution order, which is now dependency
   * order rather than the order the checks reported the issues. That ordering
   * is the whole point of the dry run: it is what makes the outcome of a real
   * apply predictable before running it (issue #48).
   */
  private renderApplyResult(result: PromoteResult, dryRun: boolean): void {
    const verb = dryRun ? 'Would apply' : 'Applied'
    if (result.applied.length > 0) {
      const heading = `${verb} ${result.applied.length} fix(es)${dryRun ? ', in this order' : ''}:`
      this.log(dryRun ? bold(heading) : ok(heading))
      result.applied.forEach((stmt, i) => {
        const glyph = dryRun ? dim(`${i + 1}.`) : ok('✓')
        this.log(`  ${glyph} ${dim(`[${stmt.check}]`)} ${stmt.issueId}`)
        // The SQL itself only in a dry run: it is the thing being reviewed,
        // and printing it after the fact would just repeat --detail.
        if (dryRun && stmt.sql) this.log(`     ${dim(stmt.sql.replace(/\s*\n\s*/g, ' '))}`)
        if (dryRun && stmt.action) this.log(`     ${dim(stmt.action)}`)
      })
    }

    if (result.skipped.length > 0) {
      this.log(`\n${dim(`Skipped ${result.skipped.length} issue(s):`)}`)
      // Collapsed where several share a reason: a posture check on a project
      // with 47 tables lacking RLS printed the same sentence 47 times, and
      // pushed the result of the apply off the top of the screen (issue #84).
      for (const line of formatSkips(result.skipped)) this.log(`  ${dim(line)}`)
    }

    // Printed before the errors: the first thing to know about a failed apply
    // is whether anything landed, and the answer here is that nothing did.
    if (result.rolledBack?.length) {
      this.log(`\n${warn(`Rolled back ${result.rolledBack.length} fix(es)`)} — the target is unchanged:`)
      for (const item of result.rolledBack) {
        this.log(`  ${dim('↩')} ${dim(`[${item.check}]`)} ${item.issueId}`)
      }
    }

    if (result.errors.length > 0) {
      this.log(`\n${warn(`${result.errors.length} error(s):`)}`)
      for (const item of result.errors) {
        this.log(`  ${warn('✗')} ${dim(`[${item.check}]`)} ${item.issueId}: ${item.error}`)
      }
      if (result.rolledBack) {
        this.log(`\n  ${dim(`Nothing was written. Re-run with ${cmd('--no-transaction')} to apply the fixes that do work.`)}`)
      }
    }

    if (dryRun) {
      this.log(`\n  ${dim(`Nothing was executed. Drop ${cmd('--dry-run')} to apply.`)}`)
    }
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Diff)

    // On stderr, so a --json or --ci consumer still gets clean stdout while a
    // human is told the flag did nothing.
    for (const { flag, shapesThePlan } of inertApplyFlags(flags as unknown as Record<string, unknown>)) {
      const suggestion = shapesThePlan
        ? `Add ${cmd('--apply')} (or ${cmd('--dry-run')} to preview) for it to take effect.`
        : `Add ${cmd('--apply')} for it to take effect.`
      process.stderr.write(`  ${warn(`--${flag} has no effect without --apply.`)} ${suggestion}\n`)
    }

    const config = await this.loadConfigOrFail()
    this.validateDualEnvConfig(config, flags.source, flags.target)

    const registry = createDefaultRegistry({ includeFiles: flags['include-files'] })
    const checks = flags.check ? [flags.check as CheckName] : undefined
    const skip = flags.skip?.length ? (flags.skip as CheckName[]) : undefined

    const tableFilter = resolveTableFilter(config, {
      tables: flags.tables,
      excludeTables: flags['exclude-tables'],
    })

    // Stated up front: a narrowed run must not look like a full one, and with
    // --apply the difference is which statements actually execute (issue #43).
    if (isFiltered(tableFilter) && !flags.json && !flags.ci) {
      this.log(`\n  ${dim(describeTableFilter(tableFilter)!)}`)
    }

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
    // `--dry-run` enters here without `--apply`: it plans, prints the execution
    // order, and writes nothing. Previewing an apply should not require typing
    // the flag that performs one (issue #71).
    if (flags.apply || flags['dry-run']) {
      const onProgress = makeProgress()
      const scanResult = await scan(registry, { config, checks, skip, tableFilter, onProgress, onDetail: makeDetail() })
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
      const dryRun = flags['dry-run']

      // Prove before touching the target. A migration that executes without
      // error can still leave the database in a state that is not the source —
      // a flattened partition or an index that never reached its partitions
      // both apply cleanly. Only replaying it and looking at the result catches
      // that, so when --prove is set a failure blocks the apply rather than
      // warning after the fact.
      if (flags.prove && !dryRun) {
        const sourceEnv = config.environments[config.source!]
        const planned = planWork(scanResult, {
          checks, only: parseFlagList(flags.only),
          allowDestructive: flags['allow-destructive'], tableFilter,
          applyPosture: flags['apply-posture'],
        })
        const migrationSql = planned.sqlStatements.map(s => s.sql).join('\n')

        this.log(`\n  ${dim('Proving convergence on a throwaway clone…')}`)
        const proof = await proveConvergence({
          sourceUrl: sourceEnv.dbUrl,
          targetUrl: targetEnv.dbUrl,
          migrationSql,
        })

        if (proof.skipped) {
          // Could not prove is not the same as failed to converge; say which.
          this.log(`  ${warn('Convergence not proven')}: ${proof.skipped}`)
          this.log(`  ${dim('Continuing — re-run without --prove to silence this.')}\n`)
        } else if (!proof.converged && residualHeldBack(proof.residual, heldBackSql(scanResult, planned)).unexplained.length === 0) {
          // Everything left over is what this run deliberately holds back.
          this.log(`  ${ok('Converged')}, apart from what is held back and stays on the target:`)
          for (const line of proof.residual.slice(0, 15)) this.log(`    ${dim(line)}`)
          this.log('')
        } else if (!proof.converged) {
          this.log(`  ${warn('Migration does not reproduce the source.')} Nothing was applied.\n`)
          const { unexplained } = residualHeldBack(proof.residual, heldBackSql(scanResult, planned))
          for (const line of unexplained.slice(0, 15)) this.log(`    ${line}`)
          if (unexplained.length > 15) {
            this.log(`    ${dim(`…and ${unexplained.length - 15} more`)}`)
          }
          this.log(`\n  ${dim('These objects would still differ after applying.')}`)
          this.exit(1)
        } else {
          this.log(`  ${ok('Converged')} — the migration reproduces the source exactly.\n`)
        }
      }

      const result = await promote({
        dbUrl: targetEnv.dbUrl,
        scanResult,
        checks,
        dryRun,
        allowDestructive: flags['allow-destructive'],
        tableFilter,
        only: parseFlagList(flags.only),
        applyPosture: flags['apply-posture'],
        transactional: !flags['no-transaction'],
      })

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2))
        return
      }

      this.renderApplyResult(result, dryRun)

      if (result.errors.length > 0) {
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
    const result = await scan(registry, { config, checks, skip, tableFilter, onProgress, onDetail: makeDetail() })
    this.setCheckSummaries(result.checks.map(c => ({
      check: c.check,
      status: c.status,
      issueCount: c.issues.length,
      durationMs: c.durationMs,
      ...(c.error ? { error: sanitizeForReport(c.error) } : {}),
    })))

    // Whether the source is a local clone changes what `--apply` means, and so
    // changes what the closing tip should say about it (issue #48).
    //
    // Two signals, because the bookkeeping one is local and exact: a clone
    // diffed from another directory, or renamed, answered "not a clone" and got
    // the unqualified "add --apply" advice in the most destructive direction
    // (issue #71). The second signal asks the databases whether the source is
    // missing the Supabase substrate the target has, which is the property that
    // makes the advice wrong.
    const sourceUrl = config.environments[config.source!]?.dbUrl
    const sourceIsClone = await isCloneDatabase(sourceUrl)
      || await sourceLooksLikeCloneOf(sourceUrl, config.environments[config.target!]?.dbUrl)

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
      const exitCode = computeCiExitCode(result, failOn, {
        failOnPosture: flags['fail-on-posture'],
      })
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
        sourceIsClone,
      }))
    } else {
      this.log(renderSummary(result))

      if (result.summary.total > 0) {
        this.log(`  → Run with ${cmd('--detail')} to see SQL diffs`)
        // Direction matters here, not just in the tip below. From a clone this
        // line was recommending the command that reshapes a shared remote to
        // match a vanilla-PostgreSQL copy — dropping the roles, grants and
        // policies the clone never had (issue #71).
        this.log(
          sourceIsClone
            ? `  → ${cmd('--apply')} would push this clone's shape onto the target, `
              + `absences included — preview it first with ${cmd('--apply --dry-run')}\n`
            : `  → Run with ${cmd('--apply')} to fix drift\n`,
        )
      }

      this.log(renderTip({
        command: 'diff',
        detail: false,
        driftTotal: result.summary.total,
        driftedChecks,
        skippedChecks,
        erroredChecks,
        singleCheck: checks?.[0],
        sourceIsClone,
      }))
    }

    // Exit code deliberately unchanged for an errored check: `--ci` is the
    // documented contract for scripting and already exits 2 in that case
    // (0=clean, 1=drift, 2=error). Making plain `diff` exit non-zero here
    // would break every non-CI caller for a signal that already has a
    // supported home. The misleading *output* is fixed above instead.
    //
    // Only drift decides the code. A critical posture finding — RLS disabled on
    // a table, a migration file with no tracking row — is true of the target
    // whichever pair you diff, so letting it exit 1 meant a perfectly
    // synchronised pair failed a sync check forever (issue #66).
    const { drift, posture } = summarizeByKind(result.checks)

    // Said once, where it changes what the reader should conclude: the report
    // above shows critical findings and the command is about to succeed.
    if (drift.critical === 0 && posture.critical > 0 && !flags.json) {
      this.log(
        `  ${dim('Posture findings do not affect the exit code — they describe the target, '
        + 'not drift from the source. Add')} ${cmd('--fail-on-posture')} ${dim('to gate on them.')}\n`,
      )
    }

    if (drift.critical > 0 || (flags['fail-on-posture'] && posture.critical > 0)) {
      this.exit(1)
    }
  }
}

/** The SQL of the fixes this run plans to skip, which the proof did not replay. */
function heldBackSql(scanResult: ScanResult, planned: { skipped: Array<{ issueId: string }> }): string[] {
  const skipped = new Set(planned.skipped.map(s => s.issueId))
  return scanResult.checks.flatMap(c => c.issues)
    .filter(i => skipped.has(i.id) && i.sql?.up)
    .map(i => i.sql!.up)
}

