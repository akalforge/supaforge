import { Command, Args, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../../config'
import { deleteBranch } from '../../branch'

export default class BranchDelete extends Command {
  static override description = 'Delete a database branch and drop its database'

  static override examples = [
    '<%= config.bin %> branch delete feature-x',
    '<%= config.bin %> branch delete feature-x --from=production',
  ]

  static override args = {
    name: Args.string({ description: 'Branch name to delete', required: true }),
  }

  static override flags = {
    from: Flags.string({
      char: 'f',
      description: 'Environment the branch was created from (for server connection)',
    }),
    force: Flags.boolean({ description: 'Skip confirmation', default: false }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchDelete)

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

    this.log(`\n🗑  Deleting branch "${args.name}"...\n`)

    try {
      await deleteBranch(args.name, env.dbUrl)
      this.log(`✅ Branch "${args.name}" deleted.\n`)
    } catch (err) {
      this.error((err as Error).message)
    }
  }
}
