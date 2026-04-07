import { Command, Flags } from '@oclif/core'
import { writeFile, mkdir } from 'node:fs/promises'
import { resolve } from 'node:path'
import { loadConfig, validateSingleEnvConfig } from '../config'
import { captureSnapshot } from '../snapshot'
import { createBranch, replaceDbName } from '../branch'
import type { SupaForgeConfig } from '../types/config'

export default class Clone extends Command {
  static override description = 'Clone a remote Supabase environment to a local database for development'

  static override examples = [
    '<%= config.bin %> clone --env=production',
    '<%= config.bin %> clone --env=production --apply',
    '<%= config.bin %> clone --env=production --local-db=local_dev --apply',
    '<%= config.bin %> clone --env=production --schema-only --apply',
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
      description: 'Actually create the local database and config (default: dry-run preview)',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Clone)

    let config
    try {
      config = await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run this command from a directory containing your config file.',
      )
    }

    const envName = flags.env ?? config.source
    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const env = config.environments[envName]
    const localDbName = flags['local-db']
    const localBaseUrl = flags['local-url']
    const localDbUrl = replaceDbName(localBaseUrl, localDbName)

    if (!flags.apply) {
      this.log('\n🔄 Clone preview (dry-run)\n')
      this.log(`  Source:      ${envName} (${redactUrl(env.dbUrl)})`)
      this.log(`  Local DB:    ${localDbName}`)
      this.log(`  Local URL:   ${redactUrl(localDbUrl)}`)
      this.log(`  Schema only: ${flags['schema-only']}`)
      this.log('')
      this.log('  Steps that would be performed:')
      this.log('    1. Create local database via pg_dump | pg_restore')
      this.log('    2. Capture full snapshot of remote environment')
      this.log('    3. Store snapshot as baseline migration')
      this.log('    4. Generate supaforge.config.json with local + remote environments')
      this.log('')
      this.log(`  The local environment "local" will be configured as source.`)
      this.log(`  The remote environment "${envName}" will be configured as target.`)
      this.log('\n  → Add --apply to execute the clone.\n')
      return
    }

    this.log(`\n🔄 Cloning "${envName}" to local database "${localDbName}"...\n`)

    // Step 1: Create local database clone
    this.log('  [1/4] Creating local database...')
    try {
      const branch = await createBranch({
        name: `clone-${localDbName}`,
        sourceUrl: env.dbUrl,
        sourceLabel: envName,
        schemaOnly: flags['schema-only'],
      })
      this.log(`    ✓ Database created: ${branch.dbName}`)
    } catch (err) {
      this.error(`Failed to create local database: ${(err as Error).message}`)
    }

    // Step 2: Capture snapshot
    this.log('  [2/4] Capturing remote snapshot...')
    const snapshot = await captureSnapshot({
      envName,
      env,
      config,
    })
    const capturedCount = Object.values(snapshot.manifest.layers).filter(l => l.captured).length
    this.log(`    ✓ Snapshot captured: ${capturedCount} layers`)

    // Step 3: Store as baseline
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

    // Step 4: Update config
    this.log('  [4/4] Updating config...')
    const newConfig: SupaForgeConfig = {
      ...config,
      environments: {
        ...config.environments,
        local: {
          dbUrl: localDbUrl,
        },
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

    this.log('\n  ✅ Clone complete!\n')
    this.log('  Your workflow is now:')
    this.log('    1. Develop against the local database')
    this.log('    2. supaforge scan          — see what drifted')
    this.log('    3. supaforge promote --apply — push changes to production')
    this.log('    4. supaforge backup --apply  — store a migration of the change')
    this.log('')
  }
}

function redactUrl(url: string): string {
  try {
    const u = new URL(url)
    if (u.password) u.password = '***'
    return u.toString()
  } catch {
    return '***'
  }
}
