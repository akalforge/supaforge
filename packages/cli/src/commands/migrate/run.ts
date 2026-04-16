import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base-command.js'
import {
  ensureMigrationsTable,
  getAppliedVersions,
  getPendingMigrations,
  runMigration,
} from '../../migrate.js'
import { ok, warn, dim, bold } from '../../ui.js'

/**
 * Execute pending migrations against a Supabase environment.
 *
 * Reads local migration files, executes unapplied ones in order,
 * and records each in supabase_migrations.schema_migrations.
 *
 * Replaces `supabase db push` for self-hosted Supabase instances.
 */
export default class MigrateRun extends BaseCommand {
  static override description = 'Execute pending migrations against a Supabase environment'

  static override examples = [
    '<%= config.bin %> migrate run --env=prod',
    '<%= config.bin %> migrate run --env=prod --dry-run',
    '<%= config.bin %> migrate run --env=prod --up-to=003',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Target environment to run migrations against',
    }),
    'dry-run': Flags.boolean({
      description: 'Preview which migrations would run without executing them',
      default: false,
    }),
    'up-to': Flags.string({
      description: 'Stop after applying this migration version (inclusive)',
    }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateRun)

    const config = await this.loadConfigOrFail()
    const { envName, env } = this.resolveEnv(config, flags.env)
    const dir = this.resolveMigrationsDir(config)

    // Preflight: verify database is reachable
    const pre = this.createPreflight('Migrate run preflight checks')
      .addDatabase('Target', envName, env.dbUrl)
    await this.runPreflight(pre, 'Migrate run')

    this.log(`${bold('migrate run')} → ${dim(envName)} (${dim(this.redactUrl(env.dbUrl))})\n`)

    // Ensure tracking table exists
    await ensureMigrationsTable(env.dbUrl)
    const applied = await getAppliedVersions(env.dbUrl)
    let pending = await getPendingMigrations(dir, applied)

    if (pending.length === 0) {
      this.log(`${ok('All migrations are up to date.')} ✓`)
      return
    }

    // Apply --up-to filter
    if (flags['up-to']) {
      const cutoff = flags['up-to']
      const idx = pending.findIndex(m => m.version === cutoff)
      if (idx === -1) {
        if (applied.has(cutoff)) {
          this.log(`${ok(`Version "${cutoff}" is already applied.`)} ✓`)
          return
        }
        this.error(`Version "${cutoff}" not found in pending migrations. Available: ${pending.map(m => m.version).join(', ')}`)
      }
      pending = pending.slice(0, idx + 1)
    }

    this.log(`Found ${bold(String(pending.length))} pending migration(s):\n`)
    for (const m of pending) {
      this.log(`  ${dim('○')} ${m.filename}`)
    }

    // Dry-run mode
    if (flags['dry-run']) {
      this.log(`\n${dim('Dry run — no changes applied.')}`)
      return
    }

    this.log('')

    // Execute migrations in order
    let applied_count = 0
    for (const migration of pending) {
      try {
        const result = await runMigration(env.dbUrl, migration)
        applied_count++
        this.log(`  ${ok('✓')} ${result.filename} ${dim(`(${result.durationMs}ms)`)}`)
      } catch (err) {
        this.log(`  ${warn('✗')} ${migration.filename}: ${err instanceof Error ? err.message : String(err)}`)
        this.log(`\n${warn(`Stopped after ${applied_count} migration(s) due to error.`)}`)
        this.exit(1)
      }
    }

    this.log(`\n${ok(`Applied ${applied_count} migration(s) successfully.`)} ✓`)
  }
}
