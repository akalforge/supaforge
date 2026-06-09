import { Flags } from '@oclif/core'
import { BaseCommand } from '../../base-command.js'
import { readLocalMigrations } from '../../checks/migrations.js'
import { getAppliedVersions, ensureMigrationsTable } from '../../migrate.js'
import { ok, warn, dim, bold } from '../../ui.js'
import { pgQuery } from '../../db.js'

/**
 * List local migration files and their applied status.
 *
 * Without --offline, connects to the target database to show which
 * migrations are applied (✓) vs pending (○).
 */
export default class MigrateList extends BaseCommand {
  static override description = 'List local migration files and their applied/pending status'

  static override examples = [
    '<%= config.bin %> migrate list',
    '<%= config.bin %> migrate list --env=production',
    '<%= config.bin %> migrate list --offline',
    '<%= config.bin %> migrate list --json',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Environment to check applied status against',
    }),
    offline: Flags.boolean({
      description: 'List local files only without connecting to the database',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(MigrateList)

    const config = await this.loadConfigOrFail()
    const dir = this.resolveMigrationsDir(config)

    const migrations = await readLocalMigrations(dir).catch(() => [])

    if (flags.offline || !config.source) {
      // Offline: list files only
      if (flags.json) {
        this.log(JSON.stringify(migrations, null, 2))
        return
      }
      if (migrations.length === 0) {
        this.log(`\n  ${dim('No local migration files found in')} ${dim(dir)}\n`)
        return
      }
      this.log(`\n  ${bold(`${migrations.length} local migration(s)`)} ${dim(`in ${dir}`)}\n`)
      for (const m of migrations) {
        this.log(`  ${dim('○')} ${m.filename}`)
      }
      this.log('')
      return
    }

    // Online: connect to DB and check applied status
    const { envName, env } = this.resolveEnv(config, flags.env)

    const pre = this.createPreflight('Migrate list preflight checks')
      .addDatabase('Target', envName, env.dbUrl)
    await this.runPreflight(pre, 'Migrate list')

    let applied: Set<string>
    try {
      await ensureMigrationsTable(env.dbUrl, pgQuery)
      applied = await getAppliedVersions(env.dbUrl, pgQuery)
    } catch {
      applied = new Set()
    }

    if (flags.json) {
      const result = migrations.map(m => ({
        ...m,
        applied: applied.has(m.version),
      }))
      this.log(JSON.stringify(result, null, 2))
      return
    }

    if (migrations.length === 0) {
      this.log(`\n  ${dim('No local migration files found in')} ${dim(dir)}\n`)
      return
    }

    const pendingCount = migrations.filter(m => !applied.has(m.version)).length
    const appliedCount = migrations.length - pendingCount

    this.log(`\n  ${bold(`${migrations.length} migration(s)`)} ${dim(`→ ${envName}`)} · ${ok(`${appliedCount} applied`)} · ${pendingCount > 0 ? warn(`${pendingCount} pending`) : dim('0 pending')}\n`)

    for (const m of migrations) {
      const isApplied = applied.has(m.version)
      const icon = isApplied ? ok('✓') : dim('○')
      const label = isApplied ? dim(m.filename) : m.filename
      this.log(`  ${icon} ${label}`)
    }
    this.log('')
  }
}
