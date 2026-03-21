import { Command, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../config'
import { createDefaultRegistry } from '../layers/index'
import { scan } from '../scanner'
import { renderDetailed } from '../render'
import type { LayerName } from '../types/drift'
import { LAYER_NAMES } from '../types/drift'

export default class Diff extends Command {
  static override description = 'Show detailed drift diff between Supabase environments'

  static override examples = [
    '<%= config.bin %> diff',
    '<%= config.bin %> diff --layer=rls',
  ]

  static override flags = {
    layer: Flags.string({
      char: 'l',
      description: 'Diff a specific layer only',
      options: [...LAYER_NAMES],
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Diff)

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

    const result = await scan(registry, { config, layers })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
    } else {
      this.log(renderDetailed(result))
    }

    if (result.summary.critical > 0) {
      this.exit(1)
    }
  }
}
