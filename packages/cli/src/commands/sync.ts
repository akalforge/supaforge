import Diff from './diff.js'

/**
 * Alias for `diff --apply` — detect and fix drift in one step.
 */
export default class Sync extends Diff {
  static override description = 'Detect and fix drift (alias for diff --apply)'

  static override examples = [
    '<%= config.bin %> sync',
    '<%= config.bin %> sync --check=rls',
    '<%= config.bin %> sync --source=staging --target=production',
  ]

  async run(): Promise<void> {
    // Inject --apply before delegating to Diff
    const argv = [...this.argv]
    if (!argv.includes('--apply')) {
      argv.push('--apply')
    }

    // Re-parse with injected --apply flag
    await Diff.run(argv, this.config)
  }
}
