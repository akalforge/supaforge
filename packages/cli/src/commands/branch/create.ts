import { Command, Args, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../../config'
import { createBranch } from '../../branch'

export default class BranchCreate extends Command {
  static override description = 'Create a database branch by copying an environment'

  static override examples = [
    '<%= config.bin %> branch create feature-x',
    '<%= config.bin %> branch create feature-x --from=production',
    '<%= config.bin %> branch create feature-x --schema-only',
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

    const errors = validateConfig(config)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const envName = flags.from ?? config.source
    const env = config.environments[envName]
    if (!env) {
      this.error(`Environment "${envName}" not found in config.`)
    }

    this.log(`\n🌿 Creating branch "${args.name}" from ${envName}...\n`)

    try {
      const meta = await createBranch({
        name: args.name,
        sourceUrl: env.dbUrl,
        sourceLabel: envName,
        schemaOnly: flags['schema-only'],
      })
      this.log(`✅ Branch created: ${meta.name}`)
      this.log(`   Database: ${meta.dbName}`)
      this.log(`   From: ${meta.createdFrom}`)
      this.log(`   Schema only: ${meta.schemaOnly}\n`)
    } catch (err) {
      this.error((err as Error).message)
    }
  }
}
