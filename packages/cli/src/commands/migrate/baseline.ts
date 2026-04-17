import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base-command.js'
import { baselineMigrations } from '../../migrate.js'
import { ok, dim, bold } from '../../ui.js'

/**
 * Mark all local migration files as applied without executing them.
 *
 * Use this when onboarding an existing self-hosted Supabase database
 * whose schema already matches the migration files.
 *
 * Creates the supabase_migrations schema and table if they don't exist.
 */
export default class MigrateBaseline extends BaseCommand {
  static override description = 'Mark all local migrations as applied without executing them'

  static override examples = [
    '<%= config.bin %> migrate baseline --env=prod',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Target environment to baseline',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateBaseline)

    const config = await this.loadConfigOrFail()
    const { envName, env } = this.resolveEnv(config, flags.env)
    const dir = this.resolveMigrationsDir(config)

    // Preflight: verify database is reachable
    const pre = this.createPreflight('Migrate baseline preflight checks')
      .addDatabase('Target', envName, env.dbUrl)
    await this.runPreflight(pre, 'Migrate baseline')

    this.log(`${bold('migrate baseline')} → ${dim(envName)} (${dim(this.redactUrl(env.dbUrl))})\n`)

    const result = await baselineMigrations(env.dbUrl, dir)

    if (result.marked.length === 0 && result.skipped.length === 0) {
      this.log(`${dim('No migration files found in')} ${dir}`)
      return
    }

    if (result.marked.length > 0) {
      this.log(`${ok(`Marked ${result.marked.length} migration(s) as applied:`)}`)
      for (const m of result.marked) {
        this.log(`  ${ok('✓')} ${m.version}_${m.name}`)
      }
    }

    if (result.skipped.length > 0) {
      this.log(`\n${dim(`Skipped ${result.skipped.length} already-recorded migration(s):`)}`)
      for (const s of result.skipped) {
        this.log(`  ${dim('○')} ${s.version} — ${s.reason}`)
      }
    }

    this.log(`\n${ok('Baseline complete.')} ✓`)
  }
}
