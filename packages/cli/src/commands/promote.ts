import { Command, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../config'
import { createDefaultRegistry } from '../checks/index'
import { scan } from '../scanner'
import { promote } from '../promote'
import type { CheckName } from '../types/drift'
import { CHECK_NAMES } from '../types/drift'

export default class Promote extends Command {
  static override description = 'Apply SQL fixes to resolve drift in the target environment'

  static override examples = [
    '<%= config.bin %> promote',
    '<%= config.bin %> promote --apply',
    '<%= config.bin %> promote --check=rls --apply',
  ]

  static override flags = {
    check: Flags.string({
      char: 'l',
      description: 'Promote a specific check only',
      options: [...CHECK_NAMES],
    }),
    apply: Flags.boolean({
      description: 'Actually execute the fixes (default: dry-run preview)',
      default: false,
    }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Promote)

    let config
    try {
      config = await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run this command from a directory containing your config file.',
      )
    }

    if (flags.source) config.source = flags.source
    if (flags.target) config.target = flags.target

    const errors = validateConfig(config)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const registry = createDefaultRegistry()
    const checks = flags.check ? [flags.check as CheckName] : undefined

    this.log('\n🔍 Scanning for drift...\n')
    const scanResult = await scan(registry, { config, checks })

    if (scanResult.summary.total === 0) {
      this.log('✅ No drift detected. Nothing to promote.')
      return
    }

    const targetEnv = config.environments[config.target]
    const dryRun = !flags.apply
    const result = await promote({
      dbUrl: targetEnv.dbUrl,
      scanResult,
      checks: checks,
      dryRun,
    })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
      return
    }

    if (dryRun) {
      this.log('📋 Preview — fixes that would be applied:\n')
      for (const stmt of result.applied) {
        this.log(`  [${stmt.check}] ${stmt.issueId}`)
        if (stmt.sql) {
          for (const line of stmt.sql.split('\n')) {
            this.log(`    ${line}`)
          }
        }
        if (stmt.action) {
          this.log(`    API: ${stmt.action}`)
        }
        this.log('')
      }
      if (result.skipped.length > 0) {
        this.log(`⏭  ${result.skipped.length} issue(s) skipped (no SQL fix available)`)
      }
      this.log('\n  → Add --apply to execute these fixes.\n')
      return
    }

    if (result.applied.length > 0) {
      this.log(`✅ Applied ${result.applied.length} fix(es):`)
      for (const stmt of result.applied) {
        this.log(`  ✓ [${stmt.check}] ${stmt.issueId}`)
      }
    }

    if (result.skipped.length > 0) {
      this.log(`\n⏭  Skipped ${result.skipped.length} issue(s):`)
      for (const item of result.skipped) {
        this.log(`  ○ [${item.check}] ${item.issueId}: ${item.reason}`)
      }
    }

    if (result.errors.length > 0) {
      this.log(`\n❌ ${result.errors.length} error(s):`)
      for (const item of result.errors) {
        this.log(`  ✖ [${item.check}] ${item.issueId}: ${item.error}`)
      }
      this.exit(1)
    }
  }
}
