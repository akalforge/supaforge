import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { findLatestSnapshot, listSnapshots } from '../snapshot'
import {
  restoreFromSnapshot,
  restoreFromMigrations,
  previewSnapshotRestore,
  previewMigrationRestore,
} from '../restore'

export default class Restore extends BaseCommand {
  static override description = 'Restore a Supabase environment from a snapshot or migration history'

  static override examples = [
    '<%= config.bin %> restore --env=local --from-snapshot=latest',
    '<%= config.bin %> restore --env=local --from-snapshot=latest --apply',
    '<%= config.bin %> restore --env=local --from-migrations --apply',
    '<%= config.bin %> restore --env=local --from-migrations --to=20260407T120000Z --apply',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Target environment to restore into',
      required: true,
    }),
    'from-snapshot': Flags.string({
      description: 'Restore from a snapshot ("latest" or a timestamp)',
      exclusive: ['from-migrations'],
    }),
    'from-migrations': Flags.boolean({
      description: 'Restore by replaying migration files',
      exclusive: ['from-snapshot'],
    }),
    to: Flags.string({
      description: 'Replay migrations up to this version (timestamp)',
    }),
    from: Flags.string({
      description: 'Replay migrations from this version (timestamp)',
    }),
    apply: Flags.boolean({
      description: 'Actually execute the restore (default: dry-run preview)',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Restore)

    if (!flags['from-snapshot'] && !flags['from-migrations']) {
      this.error('Specify --from-snapshot or --from-migrations')
    }

    const config = await this.loadConfigOrFail()

    const envName = flags.env
    const { env } = this.resolveEnv(config, envName)

    if (flags['from-snapshot']) {
      await this.handleSnapshotRestore(flags, env.dbUrl)
    } else {
      await this.handleMigrationRestore(flags, env.dbUrl)
    }
  }

  private async handleSnapshotRestore(
    flags: Record<string, unknown>,
    targetUrl: string,
  ): Promise<void> {
    const snapshotRef = flags['from-snapshot'] as string
    let snapshotDir: string

    if (snapshotRef === 'latest') {
      const latest = await findLatestSnapshot()
      if (!latest) {
        this.error('No snapshots found. Create one with "supaforge snapshot" first.')
      }
      snapshotDir = latest
    } else {
      // Assume it's a timestamp — resolve to path
      const snapshots = await listSnapshots()
      const match = snapshots.find(s => s.manifest.timestamp === snapshotRef)
      if (!match) {
        this.error(`Snapshot "${snapshotRef}" not found. Use --from-snapshot=latest or a valid timestamp.`)
      }
      snapshotDir = match.dir
    }

    if (!flags.apply) {
      this.log('\nRestore preview (dry-run) -- from snapshot\n')
      const preview = await previewSnapshotRestore(snapshotDir)
      if (preview.length === 0) {
        this.log('  No executable SQL found in snapshot.')
        return
      }

      for (const { layer, statements } of preview) {
        this.log(`  Layer: ${layer} (${statements.length} statements)`)
        for (const stmt of statements.slice(0, 3)) {
          const summary = stmt.split('\n')[0].slice(0, 80)
          this.log(`    ${summary}`)
        }
        if (statements.length > 3) {
          this.log(`    ... and ${statements.length - 3} more`)
        }
        this.log('')
      }
      this.log(`  → Add --apply to execute the restore.\n`)
      return
    }

    this.log(`\nRestoring from snapshot...\n`)

    const result = await restoreFromSnapshot({
      targetUrl,
      snapshotDir,
    })

    this.renderResult(result, flags.json as boolean)
  }

  private async handleMigrationRestore(
    flags: Record<string, unknown>,
    targetUrl: string,
  ): Promise<void> {
    const toVersion = flags.to as string | undefined
    const fromVersion = flags.from as string | undefined

    if (!flags.apply) {
      this.log('\nRestore preview (dry-run) -- from migrations\n')
      const migrations = await previewMigrationRestore(process.cwd(), toVersion, fromVersion)
      if (migrations.length === 0) {
        this.log('  No migrations found.')
        return
      }

      for (const m of migrations) {
        this.log(`  ${m.version}  ${m.description}`)
        this.log(`    Layers: ${m.layers.join(', ')}`)
        this.log(`    SQL:    ${m.up.sql.length} statements`)
        this.log(`    API:    ${m.up.api.length} actions`)
        this.log('')
      }
      this.log(`  → Add --apply to execute the restore.\n`)
      return
    }

    this.log(`\nRestoring from migrations...\n`)

    const result = await restoreFromMigrations({
      targetUrl,
      toVersion,
      fromVersion,
    })

    this.renderResult(result, flags.json as boolean)
  }

  private renderResult(
    result: Awaited<ReturnType<typeof restoreFromSnapshot>>,
    json: boolean,
  ): void {
    if (json) {
      this.log(JSON.stringify(result, null, 2))
      return
    }

    if (result.applied.length > 0) {
      this.log(`✅ Applied ${result.applied.length} operation(s):`)
      for (const op of result.applied.slice(0, 20)) {
        this.log(`  ✓ [${op.type}] ${op.label}`)
      }
      if (result.applied.length > 20) {
        this.log(`  ... and ${result.applied.length - 20} more`)
      }
    }

    if (result.skipped.length > 0) {
      this.log(`\n⏭  Skipped ${result.skipped.length} operation(s):`)
      for (const op of result.skipped) {
        this.log(`  ○ [${op.type}] ${op.label}: ${op.reason}`)
      }
    }

    if (result.errors.length > 0) {
      this.log(`\n❌ ${result.errors.length} error(s):`)
      for (const op of result.errors) {
        this.log(`  ✖ [${op.type}] ${op.label}: ${op.error}`)
      }
      this.exit(1)
    }

    this.log('')
  }
}
