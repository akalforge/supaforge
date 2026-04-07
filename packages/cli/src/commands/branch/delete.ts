import { Command, Args, Flags } from '@oclif/core'
import { loadConfig, validateSingleEnvConfig } from '../../config'
import { deleteBranch, loadManifest } from '../../branch'

export default class BranchDelete extends Command {
  static override description = 'Delete a database branch and drop its database'

  static override examples = [
    '<%= config.bin %> branch delete feature-x --apply',
    '<%= config.bin %> branch delete feature-x --from=production --apply',
  ]

  static override args = {
    name: Args.string({ description: 'Branch name to delete', required: true }),
  }

  static override flags = {
    from: Flags.string({
      char: 'f',
      description: 'Environment the branch was created from (for server connection)',
    }),
    apply: Flags.boolean({
      description: 'Actually delete the branch (default: dry-run preview)',
      default: false,
    }),
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

    const envName = flags.from ?? config.source
    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const env = config.environments[envName]

    // Verify branch exists
    const manifest = await loadManifest()
    const branch = manifest.branches.find(b => b.name === args.name)
    if (!branch) {
      this.error(`Branch "${args.name}" not found. Run "supaforge branch list" to see branches.`)
    }

    if (!flags.apply) {
      this.log(`\n🗑  Branch delete preview (dry-run)\n`)
      this.log(`  Branch:   ${branch.name}`)
      this.log(`  Database: ${branch.dbName}`)
      this.log(`  Created:  ${branch.createdAt}`)
      this.log(`  From:     ${branch.createdFrom}`)
      this.log('')
      this.log('  This would:')
      this.log(`    1. Terminate connections to "${branch.dbName}"`)
      this.log(`    2. DROP DATABASE "${branch.dbName}"`)
      this.log('    3. Remove branch from .supaforge/branches.json')
      this.log('\n  → Add --apply to delete the branch.\n')
      return
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
