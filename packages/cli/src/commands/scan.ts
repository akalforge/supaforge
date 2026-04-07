import { Command, Flags } from '@oclif/core'
import { loadConfig, validateConfig } from '../config'
import { createDefaultRegistry } from '../checks/index'
import { scan } from '../scanner'
import { renderSummary } from '../render'
import type { CheckName } from '../types/drift'
import { CHECK_NAMES } from '../types/drift'

export default class Scan extends Command {
  static override description = 'Scan all checks for drift between Supabase environments'

  static override examples = [
    '<%= config.bin %> scan',
    '<%= config.bin %> scan --check=rls',
    '<%= config.bin %> scan --json',
    '<%= config.bin %> scan --source=dev --target=prod',
  ]

  static override flags = {
    check: Flags.string({
      char: 'l',
      description: 'Scan a specific check only',
      options: [...CHECK_NAMES],
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
    source: Flags.string({ char: 's', description: 'Source environment name' }),
    target: Flags.string({ char: 't', description: 'Target environment name' }),
  }

  protected isHukam = false

  async run(): Promise<void> {
    const { flags } = await this.parse(Scan)

    if (this.isHukam) {
      this.log('\n🙏 The daily Hukamnama of your database\n')
    }

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

    const result = await scan(registry, { config, checks })

    if (flags.json) {
      this.log(JSON.stringify(result, null, 2))
    } else {
      this.log(renderSummary(result))
    }

    if (result.summary.critical > 0) {
      this.exit(1)
    }
  }
}
