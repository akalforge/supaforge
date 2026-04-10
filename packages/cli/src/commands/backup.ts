import { Command, Flags } from '@oclif/core'
import { loadConfig, validateSingleEnvConfig } from '../config'
import { backup, listMigrationFiles } from '../migration'

export default class Backup extends Command {
  static override description = 'Capture a snapshot and generate an incremental migration diff'

  static override examples = [
    '<%= config.bin %> backup --env=production',
    '<%= config.bin %> backup --env=production --apply',
    '<%= config.bin %> backup --env=production --description="added profiles table" --apply',
    '<%= config.bin %> backup --list',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Environment to back up (defaults to config source)',
    }),
    description: Flags.string({
      char: 'd',
      description: 'Human-readable description for this backup',
      default: 'auto-backup',
    }),
    apply: Flags.boolean({
      description: 'Actually write snapshot + migration files (default: dry-run preview)',
      default: false,
    }),
    list: Flags.boolean({
      description: 'List existing migrations',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Backup)

    let config
    try {
      config = await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run this command from a directory containing your config file.',
      )
    }

    if (flags.list) {
      const migrations = await listMigrationFiles()
      if (migrations.length === 0) {
        this.log('No migrations found in .supaforge/migrations/')
        return
      }
      if (flags.json) {
        this.log(JSON.stringify(migrations, null, 2))
        return
      }
      this.log(`\n📦 ${migrations.length} migration(s):\n`)
      for (const m of migrations) {
        this.log(`  ${m.version}  ${m.description.padEnd(40)} layers: ${m.layers.join(', ')}`)
      }
      this.log('')
      return
    }

    const envName = flags.env ?? config.source
    if (!envName) {
      this.error('No environment specified. Use --env=<name> or set "source" in your config.')
    }

    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const env = config.environments[envName]

    if (!flags.apply) {
      this.log('\n📦 Backup preview (dry-run)\n')
      this.log(`  Environment: ${envName}`)
      this.log(`  Description: ${flags.description}`)
      this.log('')
      this.log('  Steps that would be performed:')
      this.log('    1. Capture full snapshot of current environment state')
      this.log('    2. Compare against previous snapshot (if exists)')
      this.log('    3. Generate timestamped migration file with UP/DOWN SQL + API actions')
      this.log('    4. Store both snapshot and migration in .supaforge/')
      this.log('')

      // Show existing migration count for context
      const existing = await listMigrationFiles()
      if (existing.length > 0) {
        this.log(`  Previous migrations: ${existing.length}`)
        this.log(`  Last: ${existing[existing.length - 1].version} — ${existing[existing.length - 1].description}`)
      } else {
        this.log('  No previous snapshots — this will be a baseline capture.')
      }
      this.log('\n  → Add --apply to create the backup.\n')
      return
    }

    this.log(`\n📦 Backing up "${envName}"...\n`)

    const result = await backup({
      envName,
      env,
      config,
      description: flags.description,
    })

    if (flags.json) {
      this.log(JSON.stringify({
        isBaseline: result.isBaseline,
        snapshot: result.snapshot.manifest,
        migration: result.migration,
        migrationFile: result.migrationFile,
      }, null, 2))
      return
    }

    this.log(`  Snapshot:  ${result.snapshot.dir}`)
    if (result.isBaseline) {
      this.log('  Type:      baseline (first snapshot)')
    } else {
      this.log('  Type:      incremental diff')
    }

    if (result.migration) {
      this.log(`  Migration: ${result.migrationFile}`)
      this.log(`  Layers:    ${result.migration.layers.join(', ')}`)
      this.log(`  SQL up:    ${result.migration.up.sql.length} statement(s)`)
      this.log(`  API up:    ${result.migration.up.api.length} action(s)`)
    } else {
      this.log('  Migration: none (no changes detected)')
    }

    this.log('\n  ✅ Backup complete.\n')
  }
}
