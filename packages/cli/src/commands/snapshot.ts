import { Command, Flags } from '@oclif/core'
import { loadConfig, validateSingleEnvConfig } from '../config'
import { captureSnapshot, listSnapshots } from '../snapshot'

export default class Snapshot extends Command {
  static override description = 'Capture a full snapshot of a single Supabase environment (all checks)'

  static override examples = [
    '<%= config.bin %> snapshot --env=production',
    '<%= config.bin %> snapshot --env=production --apply',
    '<%= config.bin %> snapshot --list',
  ]

  static override flags = {
    env: Flags.string({
      char: 'e',
      description: 'Environment name to snapshot (defaults to config source)',
    }),
    apply: Flags.boolean({
      description: 'Actually write snapshot files (default: dry-run preview)',
      default: false,
    }),
    list: Flags.boolean({
      description: 'List existing snapshots',
      default: false,
    }),
    json: Flags.boolean({ description: 'Output results as JSON' }),
  }

  async run(): Promise<void> {
    const { flags } = await this.parse(Snapshot)

    let config
    try {
      config = await loadConfig()
    } catch {
      this.error(
        'Could not load supaforge.config.json. Run this command from a directory containing your config file.',
      )
    }

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
      this.log(`\n📸 ${snapshots.length} snapshot(s):\n`)
      for (const { manifest } of snapshots) {
        const layerCount = Object.values(manifest.layers).filter(l => l.captured).length
        const itemCount = Object.values(manifest.layers).reduce((sum, l) => sum + l.itemCount, 0)
        this.log(`  ${manifest.timestamp}  env=${manifest.environment}  layers=${layerCount}  items=${itemCount}`)
      }
      this.log('')
      return
    }

    const envName = flags.env ?? config.source
    const errors = validateSingleEnvConfig(config, envName)
    if (errors.length > 0) {
      this.error(`Invalid configuration:\n  ${errors.join('\n  ')}`)
    }

    const env = config.environments[envName]

    if (!flags.apply) {
      this.log('\n📸 Snapshot preview (dry-run)\n')
      this.log(`  Environment: ${envName}`)
      this.log(`  Database:    ${redactUrl(env.dbUrl)}`)
      this.log(`  Project ref: ${env.projectRef ?? 'not configured'}`)
      this.log('')
      this.log('  Layers that would be captured:')
      this.log('    ✓ schema       — pg_dump --schema-only')
      this.log('    ✓ rls          — pg_policies (CREATE POLICY statements)')
      this.log('    ✓ cron         — cron.job (cron.schedule statements)')
      this.log('    ✓ webhooks     — supabase_functions.hooks (trigger SQL)')
      this.log('    ✓ extensions   — pg_extension (CREATE EXTENSION statements)')
      if (env.projectRef && env.apiKey) {
        this.log('    ✓ auth         — Management API /config/auth (JSON)')
        this.log('    ✓ storage      — Storage API buckets (JSON) + RLS policies (SQL)')
        this.log('    ✓ edge-funcs   — Management API /functions (JSON metadata)')
      } else {
        this.log('    ○ auth         — Skipped (no projectRef/apiKey)')
        this.log('    ○ storage      — Partial (RLS policies only, no bucket API)')
        this.log('    ○ edge-funcs   — Skipped (no projectRef/apiKey)')
      }
      const dataTables = config.checks?.data?.tables ?? []
      if (dataTables.length > 0) {
        this.log(`    ✓ data         — ${dataTables.length} table(s): ${dataTables.join(', ')}`)
      } else {
        this.log('    ○ data         — Skipped (no tables configured in checks.data.tables)')
      }
      this.log('\n  → Add --apply to create the snapshot.\n')
      return
    }

    this.log(`\n📸 Capturing snapshot of "${envName}"...\n`)

    const result = await captureSnapshot({
      envName,
      env,
      config,
    })

    if (flags.json) {
      this.log(JSON.stringify(result.manifest, null, 2))
      return
    }

    this.log(`  Timestamp: ${result.timestamp}`)
    this.log(`  Directory: ${result.dir}\n`)

    for (const [layer, info] of Object.entries(result.manifest.layers)) {
      const icon = info.captured ? '✓' : '○'
      const count = info.itemCount > 0 ? ` (${info.itemCount} items)` : ''
      this.log(`  ${icon} ${layer.padEnd(20)} ${info.file}${count}`)
    }

    const capturedCount = Object.values(result.manifest.layers).filter(l => l.captured).length
    this.log(`\n  ✅ Snapshot complete: ${capturedCount} layers captured.\n`)
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
