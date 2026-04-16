import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { Flags } from '@oclif/core'
import pg from 'pg'
import { BaseCommand } from '../base-command.js'
import { captureSnapshot } from '../snapshot.js'
import {
  cloneRemoteToLocal,
  replaceDbName,
  listBranches,
  deleteBranch,
} from '../branch.js'
import { checkPgDumpCompat } from '../pg-tools.js'
import { startLocalPg, DEFAULT_LOCAL_PORT, LOCAL_PG_USER, LOCAL_PG_PASSWORD } from '../local-pg.js'
import { ok, warn, dim, cmd, bold } from '../ui.js'
import { DEFAULT_IGNORE_SCHEMAS } from '../defaults.js'
import { CLONE_EXTRA_EXCLUDE_SCHEMAS, SUPAFORGE_DIR, MIGRATIONS_SUBDIR } from '../constants.js'
import { errMsg, redactUrls } from '../utils/error.js'
import type { SupaForgeConfig } from '../types/config.js'

/** Combined list of schemas to exclude from pg_dump when cloning. */
const CLONE_EXCLUDE_SCHEMAS = [
  ...DEFAULT_IGNORE_SCHEMAS,
  ...CLONE_EXTRA_EXCLUDE_SCHEMAS,
]

/**
 * Clone a remote environment to a local database and manage clones.
 *
 * Default:              preflight checks (dry-run)
 * --apply:              execute the clone
 * --list:               list existing clones
 * --delete=NAME:        remove a clone
 * --delete=NAME --apply: actually drop the database
 */
export default class Clone extends BaseCommand {
  static override description = 'Clone a remote Supabase environment to a local database'

  static override examples = [
    '<%= config.bin %> clone --env=production',
    '<%= config.bin %> clone --env=production --apply',
    '<%= config.bin %> clone --env=production --force --apply',
    '<%= config.bin %> clone --env=production --schema-only --apply',
    '<%= config.bin %> clone --env=production --start-local --apply',
    '<%= config.bin %> clone --list',
    '<%= config.bin %> clone --delete=my-clone --apply',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Source environment to clone from (defaults to config source)',
    }),
    'local-db': Flags.string({
      description: 'Name for the local database (default: supaforge_local)',
      default: 'supaforge_local',
    }),
    'local-url': Flags.string({
      description: 'Local PostgreSQL URL (default: postgres://postgres:postgres@localhost:5432/postgres)',
      default: `postgres://${LOCAL_PG_USER}:${LOCAL_PG_PASSWORD}@localhost:${DEFAULT_LOCAL_PORT}/postgres`,
    }),
    'start-local': Flags.boolean({
      description: 'Auto-start a local PostgreSQL container via Podman or Docker',
      default: false,
    }),
    'schema-only': Flags.boolean({
      description: 'Copy schema only, no data',
      default: false,
    }),
    force: Flags.boolean({
      char: 'f',
      description: 'Drop and recreate the target database if it already exists',
      default: false,
    }),
    apply: Flags.boolean({
      description: 'Execute the operation (default: dry-run preview)',
      default: false,
    }),
    list: Flags.boolean({
      description: 'List existing clones',
      default: false,
    }),
    delete: Flags.string({
      description: 'Delete a clone by name (requires --apply to execute)',
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Clone)

    const config = await this.loadConfigOrFail()

    // ── List clones ──────────────────────────────────────────────────────────
    if (flags.list) {
      const branches = await listBranches()

      if (branches.length === 0) {
        this.log(`\n  No clones found. Create one with: ${cmd('supaforge clone --env=<name> --apply')}\n`)
        return
      }

      if (flags.json) {
        this.log(JSON.stringify(branches, null, 2))
        return
      }

      this.log(`\n  ${bold(`${branches.length} clone(s):`)}\n`)
      for (const b of branches) {
        this.log(`    ${bold(b.name)}`)
        this.log(`      Database: ${b.dbName}`)
        this.log(`      From:     ${b.createdFrom}`)
        this.log(`      Created:  ${b.createdAt}`)
        this.log(`      Schema:   ${b.schemaOnly ? 'only' : 'full'}`)
        this.log('')
      }
      return
    }

    // ── Delete clone ─────────────────────────────────────────────────────────
    if (flags.delete) {
      const { envName, env } = this.resolveEnv(config, flags.env)

      const branches = await listBranches()
      const branch = branches.find(b => b.name === flags.delete)
      if (!branch) {
        this.error(`Clone "${flags.delete}" not found. Run "supaforge clone --list" to see clones.`)
      }

      if (!flags.apply) {
        this.log(`\n  ${bold('Delete clone preview')} ${dim('(dry-run)')}\n`)
        this.log(`    Clone:    ${branch.name}`)
        this.log(`    Database: ${branch.dbName}`)
        this.log(`    Created:  ${branch.createdAt}`)
        this.log(`    From:     ${branch.createdFrom}`)
        this.log('')
        this.log('    This would:')
        this.log(`      1. Terminate connections to "${branch.dbName}"`)
        this.log(`      2. DROP DATABASE "${branch.dbName}"`)
        this.log('      3. Remove clone from .supaforge/branches.json')
        this.log(`\n    → Add ${cmd('--apply')} to delete the clone.\n`)
        return
      }

      this.log(`\n  Deleting clone "${branch.name}"...\n`)
      await deleteBranch(flags.delete, env.dbUrl)
      this.log(`  ${ok('✓')} Clone "${branch.name}" deleted.\n`)
      return
    }

    // ── Clone: preflight + execute ───────────────────────────────────────────
    const { envName, env } = this.resolveEnv(config, flags.env)
    const localDbName = flags['local-db']
    let localBaseUrl = flags['local-url']
    let startedContainer = false

    // Auto-start a local PostgreSQL container if requested
    if (flags['start-local']) {
      this.log(`\n  ${bold('Starting local PostgreSQL container...')}\n`)
      const info = await startLocalPg()
      localBaseUrl = info.url
      startedContainer = true
      this.log(`    ${ok('✓')} PostgreSQL running via ${bold(info.runtime)} on port ${info.port}\n`)
    }

    const localDbUrl = replaceDbName(localBaseUrl, localDbName)

    // Always run preflight checks — even with --apply
    const pre = this.createPreflight('Clone preflight checks')
      .addDatabase('Remote', envName, env.dbUrl)
      .addInfo('Local DB', localDbName)
      .addInfo('Local URL', dim(redactUrls(localDbUrl)))
      .addInfo('Schema only', String(flags['schema-only']))

    if (flags['start-local']) {
      pre.addCheck('Local PostgreSQL', async () => ({
        detail: `auto-started via --start-local`,
      }))
    } else {
      pre.addDatabase('Local', 'local', localBaseUrl)
    }

    pre.addCheck('pg_dump compatibility', async () => {
      try {
        const compat = await checkPgDumpCompat(env.dbUrl)
        if (compat.compatible) {
          const pathNote = compat.pgDumpPath === 'pg_dump' ? '' : ` (${compat.pgDumpPath})`
          return { detail: `v${compat.localMajor} ↔ server v${compat.serverMajor}${pathNote}` }
        }
        return { error: compat.message }
      } catch (err) {
        return { error: `pg_dump check failed: ${(err as Error).message}` }
      }
    })

    pre.addCheck('Target database', async () => {
      try {
        const client = new pg.Client({ connectionString: localBaseUrl })
        await client.connect()
        const { rows } = await client.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [localDbName],
        )
        await client.end()
        if (rows.length > 0) {
          if (flags.force) {
            return { detail: `"${localDbName}" exists — will be dropped (--force)` }
          }
          return {
            error: `"${localDbName}" already exists on local server`,
            hints: [`Use ${cmd('--force')} to drop and recreate it.`],
          }
        }
        return { detail: `"${localDbName}" does not exist yet` }
      } catch {
        return {} // Can't check — let the apply step handle it
      }
    })

    const report = await pre.run()

    if (!flags.apply) {
      if (report.passed) {
        this.log(`    Steps that will be performed:`)
        this.log('      1. Create local database via pg_dump | pg_restore')
        this.log('      2. Capture full snapshot of remote environment')
        this.log('      3. Store snapshot as baseline migration')
        this.log('      4. Update supaforge.config.json with local + remote environments')
        this.log('')
        this.log(`    → Add ${cmd('--apply')} to execute the clone.\n`)
      }
      return
    }

    if (!report.passed) {
      this.error('Clone aborted — fix the issues above first.', { exit: 1 })
    }

    // Execute clone
    this.log(`\n  ${bold(`Cloning "${envName}" to local database "${localDbName}"...`)}\n`)

    this.log('    [1/4] Creating local database...')
    try {
      await cloneRemoteToLocal({
        remoteUrl: env.dbUrl,
        localBaseUrl,
        localDbName,
        schemaOnly: flags['schema-only'],
        force: flags.force,
        excludeSchemas: CLONE_EXCLUDE_SCHEMAS,
        onProgress: (p) => {
          const mb = (p.bytesTransferred / 1024 / 1024).toFixed(1)
          const sec = Math.round(p.elapsedMs / 1000)
          process.stdout.write(`\r      ${dim(`pg_dump → pg_restore: ${mb} MB transferred (${sec}s)`)}    `)
        },
      })
      process.stdout.write('\n')
      this.log(`      ${ok('✓')} Database created: ${bold(localDbName)}`)
    } catch (err) {
      process.stdout.write('\n')
      const msg = errMsg(err)
      this.log(`      ${warn('✗')} Failed: ${msg}`)
      this.error('Clone aborted at step 1/4.', { exit: 1 })
    }

    this.log('    [2/4] Capturing remote snapshot...')
    const snapshot = await captureSnapshot({ envName, env, config })
    const capturedCount = Object.values(snapshot.manifest.layers).filter(l => l.captured).length
    this.log(`      ${ok('✓')} Snapshot captured: ${capturedCount} layers`)

    this.log('    [3/4] Storing baseline migration...')
    const migrationsDir = resolve(SUPAFORGE_DIR, MIGRATIONS_SUBDIR)
    await mkdir(migrationsDir, { recursive: true })
    const migrationFile = resolve(migrationsDir, `${snapshot.timestamp}_clone-baseline.json`)
    const migration = {
      version: snapshot.timestamp,
      description: `clone-baseline from ${envName}`,
      parent: null,
      layers: Object.entries(snapshot.manifest.layers)
        .filter(([, v]) => v.captured)
        .map(([k]) => k),
      up: { sql: [], api: [] },
      down: { sql: [], api: [] },
    }
    await writeFile(migrationFile, JSON.stringify(migration, null, 2) + '\n')
    this.log(`      ${ok('✓')} Baseline stored: ${migrationFile}`)

    this.log('    [4/4] Updating config...')
    const newConfig: SupaForgeConfig = {
      ...config,
      environments: {
        ...config.environments,
        local: { dbUrl: localDbUrl },
      },
      source: 'local',
      target: envName,
    }
    const configPath = resolve('supaforge.config.json')
    await writeFile(configPath, JSON.stringify(newConfig, null, 2) + '\n')
    this.log(`      ${ok('✓')} Config updated: ${configPath}`)

    if (flags.json) {
      this.log(JSON.stringify({ snapshot: snapshot.manifest, config: newConfig }, null, 2))
      return
    }

    this.log(`\n  ${ok('Clone complete!')}\n`)
    this.log(`  ${bold('Your workflow is now:')}`)
    this.log(`    1. Develop against the local database`)
    this.log(`    2. ${cmd('supaforge diff')}            ${dim('— see what drifted')}`)
    this.log(`    3. ${cmd('supaforge diff --apply')}     ${dim('— push changes to remote')}`)
    this.log(`    4. ${cmd('supaforge snapshot')}          ${dim('— capture the current state')}`)
    this.log('')
  }
}
