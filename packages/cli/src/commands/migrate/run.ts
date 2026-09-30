import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base-command.js'
import {
  ensureMigrationsTable,
  getAppliedVersions,
  getPendingMigrations,
  runMigration,
} from '../../migrate.js'
import { ok, warn, dim, bold } from '../../ui.js'
import { isDestructiveSql } from '../../dbdiff.js'
import { splitSqlStatements } from '../../utils/sql-split.js'
import { readFile } from 'node:fs/promises'
import { errMsg } from '../../utils/error.js'

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
    'allow-destructive': Flags.boolean({
      description: 'Permit migrations that drop tables or columns, delete rows, or drop policies',
      default: false,
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

    // `migrate run` executes by design — it is the one family that does not
    // take --apply — but that made it the one path where a DROP TABLE ran with
    // no opt-in at all, while `diff --apply` held the same statement back
    // (issue #88). The gate is the same one, and the same flag opens it.
    if (!flags['allow-destructive']) {
      const destructive = await findDestructiveStatements(pending)
      if (destructive.length > 0) {
        this.log('')
        this.log(warn(`${destructive.length} destructive statement(s) in the pending migrations:`))
        for (const { filename, sql } of destructive) {
          this.log(`  ${warn('✗')} ${filename}`)
          this.log(`      ${dim(truncateSql(sql))}`)
        }
        this.log(`\n${warn('Nothing was applied.')} Re-run with ${bold('--allow-destructive')} to proceed,`)
        this.log(`or ${bold('--dry-run')} to review the full SQL first.`)
        this.exit(1)
      }
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

/**
 * Destructive statements across a set of pending migration files.
 *
 * The SQL lives in the files rather than on the objects — `runMigration` reads
 * each one as it goes — so this reads them too. `readFileFn` is injectable for
 * the same reason `runMigration`'s is: so this can be tested without a
 * filesystem.
 *
 * Flat rather than grouped by file: the caller prints one line per statement,
 * and a migration with several destructive statements is worth seeing in full.
 * A file that cannot be read is not silently treated as safe — it is reported,
 * and `runMigration` will fail on it in a moment anyway.
 */
export async function findDestructiveStatements(
  migrations: Array<{ filename: string; path: string }>,
  readFileFn: (path: string) => Promise<string> = (path) => readFile(path, 'utf-8'),
): Promise<Array<{ filename: string; sql: string }>> {
  const found: Array<{ filename: string; sql: string }> = []

  for (const migration of migrations) {
    let sql: string
    try {
      sql = await readFileFn(migration.path)
    } catch (err) {
      found.push({ filename: migration.filename, sql: `<unreadable: ${errMsg(err)}>` })
      continue
    }

    for (const statement of splitSqlStatements(sql)) {
      if (isDestructiveSql(statement)) {
        found.push({ filename: migration.filename, sql: statement })
      }
    }
  }

  return found
}

/** One line of SQL for a listing, whatever the statement's shape. */
function truncateSql(sql: string): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim()
  return oneLine.length > 100 ? `${oneLine.slice(0, 97)}...` : oneLine
}
