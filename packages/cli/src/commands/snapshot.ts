import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { captureSnapshot, listSnapshots, pruneSnapshots, DEFAULT_KEEP_COUNT } from '../snapshot.js'
import { backup, listMigrationFiles } from '../migration.js'
import type { SnapshotManifest } from '../types/config.js'

/**
 * Capture and manage environment state snapshots.
 *
 * Default:      capture a snapshot (no dry-run gate — just runs)
 * --migration:  also generate an incremental migration diff (was: backup)
 * --list:       list existing snapshots
 * --prune:      delete old snapshots
 */
export default class Snapshot extends BaseCommand {
  static override description = 'Capture a point-in-time snapshot of a Supabase environment'

  static override examples = [
    '<%= config.bin %> snapshot',
    '<%= config.bin %> snapshot --env=production',
    '<%= config.bin %> snapshot --migration',
    '<%= config.bin %> snapshot --migration --description="added profiles table"',
    '<%= config.bin %> snapshot --list',
    '<%= config.bin %> snapshot --prune',
    '<%= config.bin %> snapshot --prune --keep=5 --apply',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Environment to snapshot (defaults to config source)',
    }),
    migration: Flags.boolean({
      description: 'Also generate an incremental migration diff against the previous snapshot',
      default: false,
    }),
    description: Flags.string({
      char: 'd',
      description: 'Human-readable description for the migration',
      default: 'auto-backup',
    }),
    list: Flags.boolean({
      description: 'List existing snapshots',
      default: false,
    }),
    prune: Flags.boolean({
      description: `Delete old snapshots, keeping the most recent (default: ${DEFAULT_KEEP_COUNT})`,
      default: false,
    }),
    keep: Flags.integer({
      description: 'Number of snapshots to keep when pruning',
      default: DEFAULT_KEEP_COUNT,
      min: 1,
    }),
    apply: Flags.boolean({
      description: 'Confirm destructive action (required for --prune)',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Snapshot)

    const config = await this.loadConfigOrFail()

    // ── List mode ────────────────────────────────────────────────────────────
    if (flags.list) {
      const snapshots = await listSnapshots()
      if (snapshots.length === 0) {
        this.log('No snapshots found.')
        return
      }
      if (flags.json) {
        this.log(JSON.stringify(snapshots.map(s => s.manifest), null, 2))
        return
      }
      this.log(`\n${snapshots.length} snapshot(s):\n`)
      for (const { manifest } of snapshots) {
        const layerCount = Object.values(manifest.layers).filter(l => l.captured).length
        const itemCount = Object.values(manifest.layers).reduce((sum, l) => sum + l.itemCount, 0)
        this.log(`  ${manifest.timestamp}  env=${manifest.environment}  layers=${layerCount}  items=${itemCount}`)
      }
      this.log('')
      return
    }

    // ── Prune mode ───────────────────────────────────────────────────────────
    if (flags.prune) {
      const keepCount = flags.keep
      const snapshots = await listSnapshots()
      const deleteCount = Math.max(0, snapshots.length - keepCount)

      if (deleteCount === 0) {
        this.log(`\nNothing to prune — ${snapshots.length} snapshot(s), keeping ${keepCount}.\n`)
        return
      }

      this.log(`\nPrune: ${snapshots.length} snapshot(s) found, keeping ${keepCount}.`)
      this.log(`  ${deleteCount} snapshot(s) would be deleted:\n`)

      const toDelete = snapshots.slice(0, deleteCount)
      for (const { manifest } of toDelete) {
        this.log(`  ✗ ${manifest.timestamp}  env=${manifest.environment}`)
      }
      this.log('')

      if (!flags.apply) {
        this.log('  → Add --apply to delete these snapshots.\n')
        return
      }

      const result = await pruneSnapshots(keepCount)

      if (flags.json) {
        this.log(JSON.stringify(result, null, 2))
        return
      }

      this.log(`  Deleted ${result.deleted.length} snapshot(s), ${result.kept.length} remaining.\n`)
      return
    }

    // ── Capture snapshot (with optional migration) ───────────────────────────
    const { envName, env } = this.resolveEnv(config, flags.env)

    if (flags.migration) {
      // Capture + generate migration (was: backup command)
      this.log(`\nCapturing snapshot of "${envName}" with migration...\n`)

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

      this.logSnapshotResult(result.snapshot.manifest)

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

      this.log('\n  Snapshot + migration complete.\n')
      return
    }

    // Plain snapshot — just capture, no dry-run gate
    this.log(`\nCapturing snapshot of "${envName}"...\n`)

    const snapshot = await captureSnapshot({ envName, env, config })

    if (flags.json) {
      this.log(JSON.stringify(snapshot.manifest, null, 2))
      return
    }

    this.logSnapshotResult(snapshot.manifest)

    // Show migration hint
    const existing = await listMigrationFiles()
    if (existing.length > 0) {
      this.log(`\n  → Run with --migration to also generate an incremental diff.`)
    } else {
      this.log(`\n  → Run with --migration to save a baseline migration.`)
    }
    this.log('')
  }

  private logSnapshotResult(manifest: SnapshotManifest): void {
    const layers = manifest.layers as Record<string, {
      captured: boolean
      itemCount: number
      error?: string
      skipReason?: string
    }>

    for (const [name, info] of Object.entries(layers)) {
      if (info.captured) {
        this.log(`  ✓ ${name.padEnd(16)} ${info.itemCount} item(s)`)
      } else if (info.error) {
        this.log(`  ✗ ${name.padEnd(16)} error: ${info.error}`)
      } else {
        const skipSuffix = info.skipReason ? ` — ${info.skipReason}` : ''
        this.log(`  ○ ${name.padEnd(16)} skipped${skipSuffix}`)
      }
    }
  }
}
