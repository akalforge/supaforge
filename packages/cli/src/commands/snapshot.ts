import { Flags } from '@oclif/core'
import { BaseCommand } from '../base-command.js'
import { captureSnapshot, listSnapshots, pruneSnapshots, DEFAULT_KEEP_COUNT } from '../snapshot.js'
import { backup, listMigrationFiles } from '../migration.js'
import type { SnapshotManifest } from '../types/config.js'
import { ok, warn, dim, cmd, bold } from '../ui.js'

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
    '<%= config.bin %> snapshot --output=./backups',
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
    output: Flags.string({
      char: 'o',
      description: 'Custom output directory for snapshot files (timestamp subfolder is created inside)',
    }),
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
      this.log(`\n${bold(`${snapshots.length} snapshot(s):`)}\n`)
      for (const { manifest } of snapshots) {
        const layerCount = Object.values(manifest.layers).filter(l => l.captured).length
        const itemCount = Object.values(manifest.layers).reduce((sum, l) => sum + l.itemCount, 0)
        this.log(`  ${bold(manifest.timestamp)}  ${dim('env=')}${manifest.environment}  ${dim('layers=')}${layerCount}  ${dim('items=')}${itemCount}`)
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
        this.log(`  ${warn('✗')} ${manifest.timestamp}  ${dim('env=')}${manifest.environment}`)
      }
      this.log('')

      if (!flags.apply) {
        this.log(`  → Add ${cmd('--apply')} to delete these snapshots.\n`)
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

    // Preflight: verify database is reachable
    if (!flags.json) {
      const pre = this.createPreflight('Snapshot preflight checks')
        .addDatabase('Database', envName, env.dbUrl)
      await this.runPreflight(pre, 'Snapshot')
    }

    if (flags.migration) {
      // Capture + generate migration (was: backup command)
      this.log(`\nCapturing snapshot of "${envName}" with migration...\n`)

      const result = await backup({
        envName,
        env,
        config,
        description: flags.description,
        outputDir: flags.output,
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
      this.log(`  ${dim('Snapshot:')}  ${result.snapshot.dir}`)

      if (result.isBaseline) {
        this.log(`  ${dim('Type:')}      baseline (first snapshot)`)
      } else {
        this.log(`  ${dim('Type:')}      incremental diff`)
      }

      if (result.migration) {
        this.log(`  ${dim('Migration:')} ${result.migrationFile}`)
        this.log(`  ${dim('Layers:')}    ${result.migration.layers.join(', ')}`)
        this.log(`  ${dim('SQL up:')}    ${result.migration.up.sql.length} statement(s)`)
        this.log(`  ${dim('API up:')}    ${result.migration.up.api.length} action(s)`)
      } else {
        this.log(`  ${dim('Migration:')} none (no changes detected)`)
      }

      this.log(`\n  ${ok('Snapshot + migration complete.')}\n`)
      return
    }

    // Plain snapshot — just capture, no dry-run gate
    this.log(`\nCapturing snapshot of "${envName}"...\n`)

    const snapshot = await captureSnapshot({ envName, env, config, outputDir: flags.output })

    if (flags.json) {
      this.log(JSON.stringify(snapshot.manifest, null, 2))
      return
    }

    this.logSnapshotResult(snapshot.manifest)
    this.log(`\n  ${dim('Snapshot saved to:')} ${snapshot.dir}`)

    // Show migration hint
    const existing = await listMigrationFiles()
    if (existing.length > 0) {
      this.log(`  → Run with ${cmd('--migration')} to also generate an incremental diff.`)
    } else {
      this.log(`  → Run with ${cmd('--migration')} to save a baseline migration.`)
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
        this.log(`  ${ok('✓')} ${name.padEnd(16)} ${info.itemCount} item(s)`)
      } else if (info.error) {
        this.log(`  ${warn('✗')} ${name.padEnd(16)} ${warn(`error: ${info.error}`)}`)
      } else {
        const skipSuffix = info.skipReason ? ` — ${info.skipReason}` : ''
        this.log(`  ${dim('○')} ${name.padEnd(16)} ${dim(`skipped${skipSuffix}`)}`)
      }
    }
  }
}
