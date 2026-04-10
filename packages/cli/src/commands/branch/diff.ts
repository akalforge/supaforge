import { Command, Args, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../../config'
import { loadManifest, type BranchMeta } from '../../branch'
import { createDefaultRegistry } from '../../checks/index'
import { scan } from '../../scanner'
import { renderSummary } from '../../render'

export default class BranchDiff extends Command {
  static override description = 'Compare a branch against an environment to see what changed'

  static override examples = [
    '<%= config.bin %> branch diff feature-x',
    '<%= config.bin %> branch diff feature-x --against=production',
    '<%= config.bin %> branch diff feature-x --json',
  ]

  static override args = {
    name: Args.string({ description: 'Branch name to diff', required: true }),
  }

  static override flags = {
    against: Flags.string({
      char: 'a',
      description: 'Environment to compare against (defaults to config source)',
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { args, flags } = await this.parse(BranchDiff)

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

    const manifest = await loadManifest()
    const branch = manifest.branches.find((b: BranchMeta) => b.name === args.name)
    if (!branch) {
      this.error(`Branch "${args.name}" not found. Run "supaforge branch list" to see branches.`)
    }

    const envName = flags.against ?? config.source
    if (!envName) {
      this.error('No environment specified. Use --against=<name> or set "source" in your config.')
    }

    const env = config.environments[envName]
    if (!env) {
      this.error(`Environment "${envName}" not found in config.`)
    }

    this.log(`\n🔍 Diffing branch "${args.name}" against ${envName}...\n`)

    // Build a temporary config where source = the environment, target = the branch
    const branchConfig = {
      ...config,
      source: envName,
      target: '__branch__',
      environments: {
        ...config.environments,
        __branch__: { dbUrl: branch.dbUrl },
      },
    }

    const registry = createDefaultRegistry()
    const result = await scan(registry, { config: branchConfig })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
    } else {
      this.log(renderSummary(result))
    }
  }
}
