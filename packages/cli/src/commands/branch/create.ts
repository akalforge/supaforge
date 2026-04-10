import { Command, Args, Flags } from '@oclif/core'
import { loadConfig, validateSingleEnvConfig } from '../../config'
import { createBranch } from '../../branch'

export default class BranchCreate extends Command {
  static override description = 'Create a database branch by copying an environment (with full snapshot)'

  static override examples = [
    '<%= config.bin %> branch create feature-x --apply',
    '<%= config.bin %> branch create feature-x --from=production --apply',
    '<%= config.bin %> branch create feature-x --schema-only --apply',
  ]

  static override args = {
    name: Args.string({ description: 'Name for the new branch', required: true }),
  }

  static override flags = {
    from: Flags.string({
      char: 'f',
      description: 'Source environment to branch from (defaults to config source)',
    }),
    'schema-only': Flags.boolean({
      description: 'Copy schema only, no data',
      default: false,
    }),
    apply: Flags.boolean({
      description: 'Actually create the branch (default: dry-run preview)',
      default: false,
    }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchCreate)

    let config
    try {
      config = await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run this command from a directory containing your config file.',
      )
    }

    const envName = flags.from ?? config.source
    if (!envName) {
      this.error('No environment specified. Use --from=<name> or set "source" in your config.')
    }

    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const env = config.environments[envName]

    if (!flags.apply) {
      this.log(`\n🌿 Branch preview (dry-run)\n`)
      this.log(`  Branch name:  ${args.name}`)
      this.log(`  Source:       ${envName}`)
      this.log(`  Schema only:  ${flags['schema-only']}`)
      this.log('')
      this.log('  Steps that would be performed:')
      this.log('    1. Create database via pg_dump | pg_restore')
      this.log('    2. Capture all-layer snapshot of source environment')
      this.log('    3. Store branch metadata in .supaforge/branches.json')
      this.log('\n  → Add --apply to create the branch.\n')
      return
    }

    this.log(`\n🌿 Creating branch "${args.name}" from ${envName}...\n`)

    try {
      const meta = await createBranch({
        name: args.name,
        sourceUrl: env.dbUrl,
        sourceLabel: envName,
        schemaOnly: flags['schema-only'],
        env,
        config,
      })
      this.log(`✅ Branch created: ${meta.name}`)
      this.log(`   Database: ${meta.dbName}`)
      this.log(`   From: ${meta.createdFrom}`)
      this.log(`   Schema only: ${meta.schemaOnly}`)
      if (meta.snapshotDir) {
        this.log(`   Snapshot: ${meta.snapshotDir}`)
      }
      this.log('')
    } catch (err) {
      this.error((err as Error).message)
    }
  }
}
