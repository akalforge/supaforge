import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { createDefaultRegistry } from '../checks/index.js'
import { scan } from '../scanner.js'
import { renderSummary, renderDetailed } from '../render.js'
import { promote } from '../promote.js'
import type { CheckName } from '../types/drift.js'
import { CHECK_NAMES } from '../types/drift.js'

/**
 * Unified drift detection & resolution command.
 *
 * Default:   summary of what's drifted (was: scan)
 * --detail:  full SQL diffs (was: diff)
 * --apply:   fix the drift (was: promote)
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
  ]

  static override flags = {
    check: Flags.string({
      char: 'l',
      description: 'Limit to a specific check',
      options: [...CHECK_NAMES],
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
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Diff)

    const config = await this.loadConfigOrFail()
    this.validateDualEnvConfig(config, flags.source, flags.target)

    const registry = createDefaultRegistry({ includeFiles: flags['include-files'] })
    const checks = flags.check ? [flags.check as CheckName] : undefined

    // ── Apply mode (was: promote) ────────────────────────────────────────────
    if (flags.apply) {
      this.log('\nScanning for drift...\n')
      const scanResult = await scan(registry, { config, checks })

      if (scanResult.summary.total === 0) {
        this.log('No drift detected. Nothing to apply. ✓')
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
        this.log(`Applied ${result.applied.length} fix(es):`)
        for (const stmt of result.applied) {
          this.log(`  ✓ [${stmt.check}] ${stmt.issueId}`)
        }
      }

      if (result.skipped.length > 0) {
        this.log(`\nSkipped ${result.skipped.length} issue(s):`)
        for (const item of result.skipped) {
          this.log(`  ○ [${item.check}] ${item.issueId}: ${item.reason}`)
        }
      }

      if (result.errors.length > 0) {
        this.log(`\n${result.errors.length} error(s):`)
        for (const item of result.errors) {
          this.log(`  ✗ [${item.check}] ${item.issueId}: ${item.error}`)
        }
        this.exit(1)
      }

      return
    }

    // ── Scan mode (summary or detail) ────────────────────────────────────────
    const result = await scan(registry, { config, checks })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
    } else if (flags.detail) {
      this.log(renderDetailed(result))
    } else {
      this.log(renderSummary(result))

      if (result.summary.total > 0) {
        this.log('  → Run with --detail to see SQL diffs')
        this.log('  → Run with --apply to fix drift\n')
      }
    }

    if (result.summary.critical > 0) {
      this.exit(1)
    }
  }
}
