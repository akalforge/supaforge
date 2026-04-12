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
import type { SupaForgeConfig } from '../types/config.js'

/** Default local Supabase CLI PostgreSQL port. */
const SUPABASE_LOCAL_PORT = '54322'

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
    '<%= config.bin %> clone --env=production --schema-only --apply',
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
      description: 'Local PostgreSQL URL (default: postgres://postgres:postgres@localhost:54322/postgres)',
      default: 'postgres://postgres:postgres@localhost:54322/postgres',
    }),
    'schema-only': Flags.boolean({
      description: 'Copy schema only, no data',
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
        this.log('\nNo clones found. Create one with: supaforge clone --env=<name> --apply\n')
        return
      }

      if (flags.json) {
        this.log(JSON.stringify(branches, null, 2))
        return
      }

      this.log(`\n${branches.length} clone(s):\n`)
      for (const b of branches) {
        this.log(`  ${b.name}`)
        this.log(`    Database: ${b.dbName}`)
        this.log(`    From:     ${b.createdFrom}`)
        this.log(`    Created:  ${b.createdAt}`)
        this.log(`    Schema:   ${b.schemaOnly ? 'only' : 'full'}`)
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
        this.log(`\nDelete clone preview (dry-run)\n`)
        this.log(`  Clone:    ${branch.name}`)
        this.log(`  Database: ${branch.dbName}`)
        this.log(`  Created:  ${branch.createdAt}`)
        this.log(`  From:     ${branch.createdFrom}`)
        this.log('')
        this.log('  This would:')
        this.log(`    1. Terminate connections to "${branch.dbName}"`)
        this.log(`    2. DROP DATABASE "${branch.dbName}"`)
        this.log('    3. Remove clone from .supaforge/branches.json')
        this.log('\n  → Add --apply to delete the clone.\n')
        return
      }

      this.log(`\nDeleting clone "${flags.delete}"...\n`)
      await deleteBranch(flags.delete, env.dbUrl)
      this.log(`  Clone "${flags.delete}" deleted.\n`)
      return
    }

    // ── Clone: preflight + execute ───────────────────────────────────────────
    const { envName, env } = this.resolveEnv(config, flags.env)
    const localDbName = flags['local-db']
    const localBaseUrl = flags['local-url']
    const localDbUrl = replaceDbName(localBaseUrl, localDbName)

    if (!flags.apply) {
      await this.runPreflightChecks(envName, env.dbUrl, localDbName, localBaseUrl, localDbUrl, flags['schema-only'])
      return
    }

    // Execute clone
    this.log(`\nCloning "${envName}" to local database "${localDbName}"...\n`)

    this.log('  [1/4] Creating local database...')
    try {
      await cloneRemoteToLocal({
        remoteUrl: env.dbUrl,
        localBaseUrl,
        localDbName,
        schemaOnly: flags['schema-only'],
      })
      this.log(`    + Database created: ${localDbName}`)
    } catch (err) {
      this.error(`Failed to create local database: ${(err as Error).message}`)
    }

    this.log('  [2/4] Capturing remote snapshot...')
    const snapshot = await captureSnapshot({ envName, env, config })
    const capturedCount = Object.values(snapshot.manifest.layers).filter(l => l.captured).length
    this.log(`    ✓ Snapshot captured: ${capturedCount} layers`)

    this.log('  [3/4] Storing baseline migration...')
    const migrationsDir = resolve('.supaforge', 'migrations')
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
    this.log(`    ✓ Baseline stored: ${migrationFile}`)

    this.log('  [4/4] Updating config...')
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
    this.log(`    ✓ Config updated: ${configPath}`)

    if (flags.json) {
      this.log(JSON.stringify({ snapshot: snapshot.manifest, config: newConfig }, null, 2))
      return
    }

    this.log('\n  Clone complete!\n')
    this.log('  Your workflow is now:')
    this.log('    1. Develop against the local database')
    this.log('    2. supaforge diff            — see what drifted')
    this.log('    3. supaforge diff --apply     — push changes to remote')
    this.log('    4. supaforge snapshot          — capture the current state')
    this.log('')
  }

  /** Validate that cloning is possible before the user commits with --apply. */
  private async runPreflightChecks(
    envName: string,
    remoteUrl: string,
    localDbName: string,
    localBaseUrl: string,
    localDbUrl: string,
    schemaOnly: boolean,
  ): Promise<void> {
    this.log('\nClone preflight checks\n')
    this.log(`  Source:      ${envName} (${this.redactUrl(remoteUrl)})`)
    this.log(`  Local DB:    ${localDbName}`)
    this.log(`  Local URL:   ${this.redactUrl(localDbUrl)}`)
    this.log(`  Schema only: ${schemaOnly}`)
    this.log('')

    let failed = false

    this.log('  Checks:')

    // Check 1: Remote DB reachable
    try {
      const client = new pg.Client({ connectionString: remoteUrl })
      await client.connect()
      const { rows } = await client.query('SHOW server_version')
      const serverVersion = (rows[0] as Record<string, string>).server_version
      await client.end()
      this.log(`    ✓ Remote database reachable (PostgreSQL ${serverVersion})`)
    } catch (err) {
      this.log(`    ✗ Remote database not reachable: ${(err as Error).message}`)
      failed = true
    }

    // Check 2: pg_dump compatibility
    if (!failed) {
      try {
        const compat = await checkPgDumpCompat(remoteUrl)
        if (compat.compatible) {
          const pathNote = compat.pgDumpPath === 'pg_dump' ? '' : ` (${compat.pgDumpPath})`
          this.log(`    ✓ pg_dump v${compat.localMajor} compatible with server v${compat.serverMajor}${pathNote}`)
        } else {
          this.log(`    ✗ ${compat.message}`)
          failed = true
        }
      } catch (err) {
        this.log(`    ✗ pg_dump check failed: ${(err as Error).message}`)
        failed = true
      }
    }

    // Check 3: Local PostgreSQL reachable (with Supabase CLI hint)
    try {
      const client = new pg.Client({ connectionString: localBaseUrl })
      await client.connect()
      await client.end()
      this.log('    ✓ Local PostgreSQL reachable')
    } catch (err) {
      const urlObj = new URL(localBaseUrl)
      const isSupabasePort = urlObj.port === SUPABASE_LOCAL_PORT
      const hint = isSupabasePort
        ? `\n\n  Hint: Port ${SUPABASE_LOCAL_PORT} is the Supabase CLI default. Run "supabase start" to start your local Supabase instance.`
        : ''
      this.log(`    ✗ Local PostgreSQL not reachable at ${this.redactUrl(localBaseUrl)}: ${(err as Error).message}${hint}`)
      failed = true
    }

    // Check 4: Target database doesn't already exist
    if (!failed) {
      try {
        const client = new pg.Client({ connectionString: localBaseUrl })
        await client.connect()
        const { rows } = await client.query(
          'SELECT 1 FROM pg_database WHERE datname = $1',
          [localDbName],
        )
        await client.end()
        if (rows.length > 0) {
          this.log(`    ✗ Database "${localDbName}" already exists on local server`)
          failed = true
        } else {
          this.log(`    ✓ Database "${localDbName}" does not exist yet`)
        }
      } catch {
        // If we can't check, let the apply step handle it
      }
    }

    this.log('')
    if (failed) {
      this.log('  Some checks failed. Fix the issues above before cloning.\n')
      return
    }

    this.log('  All checks passed. Steps that will be performed:')
    this.log('    1. Create local database via pg_dump | pg_restore')
    this.log('    2. Capture full snapshot of remote environment')
    this.log('    3. Store snapshot as baseline migration')
    this.log('    4. Update supaforge.config.json with local + remote environments')
    this.log('')
    this.log('  → Add --apply to execute the clone.\n')
  }
}
