import { Command, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../config'
import { createDefaultRegistry } from '../layers/index'
import { scan } from '../scanner'
import { promote } from '../promote'
import type { LayerName } from '../types/drift'
import { LAYER_NAMES } from '../types/drift'

export default class Promote extends Command {
  static override description = 'Apply SQL fixes to resolve drift in the target environment'

  static override examples = [
    '<%= config.bin %> promote',
    '<%= config.bin %> promote --layer=rls',
    '<%= config.bin %> promote --dry-run',
  ]

  static override flags = {
    layer: Flags.string({
      char: 'l',
      description: 'Promote a specific layer only',
      options: [...LAYER_NAMES],
    }),
    'dry-run': Flags.boolean({
      description: 'Show SQL that would be applied without executing',
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
    const layers = flags.layer ? [flags.layer as LayerName] : undefined

    this.log('\n🔍 Scanning for drift...\n')
    const scanResult = await scan(registry, { config, layers })

    if (scanResult.summary.total === 0) {
      this.log('✅ No drift detected. Nothing to promote.')
      return
    }

    const targetEnv = config.environments[config.target]
    const result = await promote({
      dbUrl: targetEnv.dbUrl,
      scanResult,
      layers: layers,
      dryRun: flags['dry-run'],
    })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
      return
    }

    if (flags['dry-run']) {
      this.log('📋 Dry-run — SQL that would be applied:\n')
      for (const stmt of result.applied) {
        this.log(`  [${stmt.layer}] ${stmt.issueId}`)
        for (const line of stmt.sql.split('\n')) {
          this.log(`    ${line}`)
        }
        this.log('')
      }
      if (result.skipped.length > 0) {
        this.log(`⏭  ${result.skipped.length} issue(s) skipped (no SQL fix available)`)
      }
      return
    }

    if (result.applied.length > 0) {
      this.log(`✅ Applied ${result.applied.length} fix(es):`)
      for (const stmt of result.applied) {
        this.log(`  ✓ [${stmt.layer}] ${stmt.issueId}`)
      }
    }

    if (result.skipped.length > 0) {
      this.log(`\n⏭  Skipped ${result.skipped.length} issue(s):`)
      for (const item of result.skipped) {
        this.log(`  ○ [${item.layer}] ${item.issueId}: ${item.reason}`)
      }
    }

    if (result.errors.length > 0) {
      this.log(`\n❌ ${result.errors.length} error(s):`)
      for (const item of result.errors) {
        this.log(`  ✖ [${item.layer}] ${item.issueId}: ${item.error}`)
      }
      this.exit(1)
    }
  }
}
