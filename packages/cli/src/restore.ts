import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import type { MigrationFile, SnapshotManifest } from './types/config'
import { MIGRATIONS_TABLE, loadMigrations } from './migration'
import { loadSnapshot } from './snapshot'
import type { QueryFn } from './db'
import { pgQuery } from './db'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export interface RestoreOptions {
  /** Target database URL to restore into. */
  targetUrl: string
  /** Project ref for API-based operations (auth, storage, edge functions). */
  targetProjectRef?: string
  /** API key for Supabase Management API. */
  targetApiKey?: string
  /** Restore from a specific snapshot directory. */
  snapshotDir?: string
  /** Or restore from migrations up to a specific version. */
  toVersion?: string
  /** Starting version (skip migrations before this). */
  fromVersion?: string
  /** Working directory for .supaforge/ */
  cwd?: string
  /** Query function for DB operations. */
  queryFn?: QueryFn
  /** Fetch function for API operations. */
  fetchFn?: FetchFn
}

export interface RestoreResult {
  applied: { type: 'sql' | 'api'; label: string }[]
  skipped: { type: 'sql' | 'api'; label: string; reason: string }[]
  errors: { type: 'sql' | 'api'; label: string; error: string }[]
  mode: 'snapshot' | 'migrations'
}

// ─── Restore from Snapshot ───────────────────────────────────────────────────

/**
 * Restore a Supabase environment from a snapshot directory.
 * Applies all SQL files (schema, RLS, cron, webhooks, extensions, data).
 * API layers (auth, storage buckets, edge functions) log what would need manual action.
 */
export async function restoreFromSnapshot(options: RestoreOptions): Promise<RestoreResult> {
  if (!options.snapshotDir) throw new Error('snapshotDir is required for snapshot restore')

  const result: RestoreResult = { applied: [], skipped: [], errors: [], mode: 'snapshot' }
  const manifest = await loadSnapshot(options.snapshotDir)

  // Apply SQL layers in dependency order
  const sqlOrder = ['extensions', 'schema', 'rls', 'cron', 'webhooks', 'storage-policies']
  const client = new pg.Client({ connectionString: options.targetUrl })
  await client.connect()

  try {
    for (const layer of sqlOrder) {
      const file = layerRestoreFile(layer)
      const info = manifest.layers[layer === 'storage-policies' ? 'storage' : layer]
      if (!info?.captured) {
        result.skipped.push({ type: 'sql', label: `Layer: ${layer}`, reason: 'Not captured in snapshot' })
        continue
      }

      try {
        const content = await readFile(join(options.snapshotDir, file), 'utf-8')
        const statements = extractExecutableStatements(content)
        for (const sql of statements) {
          try {
            await client.query(sql)
            result.applied.push({ type: 'sql', label: summarizeStatement(sql) })
          } catch (err) {
            result.errors.push({
              type: 'sql',
              label: summarizeStatement(sql),
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      } catch {
        result.skipped.push({ type: 'sql', label: `Layer: ${layer}`, reason: 'File not readable' })
      }
    }

    // Apply data if present
    if (manifest.layers.data?.captured) {
      try {
        const dataDir = join(options.snapshotDir, 'data')
        const { readdir } = await import('node:fs/promises')
        const dataFiles = await readdir(dataDir)
        for (const file of dataFiles.filter(f => f.endsWith('.sql')).sort()) {
          const content = await readFile(join(dataDir, file), 'utf-8')
          const statements = extractExecutableStatements(content)
          for (const sql of statements) {
            try {
              await client.query(sql)
              result.applied.push({ type: 'sql', label: `Data: ${file}` })
            } catch (err) {
              result.errors.push({
                type: 'sql',
                label: `Data: ${file}`,
                error: err instanceof Error ? err.message : String(err),
              })
            }
          }
        }
      } catch { /* no data dir */ }
    }
  } finally {
    await client.end()
  }

  // Note API layers that need manual action
  if (manifest.layers.auth?.captured) {
    result.skipped.push({
      type: 'api',
      label: 'Auth config',
      reason: 'Requires --project-ref and --api-key to restore via Management API',
    })
  }
  if (manifest.layers['edge-functions']?.captured) {
    result.skipped.push({
      type: 'api',
      label: 'Edge Functions',
      reason: 'Deploy via "supabase functions deploy" from your local functions directory',
    })
  }

  return result
}

// ─── Restore from Migrations ─────────────────────────────────────────────────

/**
 * Restore by replaying migration files in order.
 * Tracks applied migrations in a `_supaforge_migrations` table.
 */
export async function restoreFromMigrations(options: RestoreOptions): Promise<RestoreResult> {
  const cwd = options.cwd ?? process.cwd()
  const result: RestoreResult = { applied: [], skipped: [], errors: [], mode: 'migrations' }
  const queryFn = options.queryFn ?? pgQuery

  const migrations = await loadMigrations(cwd)
  if (migrations.length === 0) {
    result.skipped.push({ type: 'sql', label: 'No migrations', reason: 'No migration files found in .supaforge/migrations/' })
    return result
  }

  // Filter by version range
  let filtered = migrations
  if (options.fromVersion) {
    filtered = filtered.filter(m => m.version >= options.fromVersion!)
  }
  if (options.toVersion) {
    filtered = filtered.filter(m => m.version <= options.toVersion!)
  }

  // Ensure tracking table exists
  const client = new pg.Client({ connectionString: options.targetUrl })
  await client.connect()

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
        version TEXT PRIMARY KEY,
        description TEXT,
        applied_at TIMESTAMPTZ DEFAULT NOW()
      )
    `)

    // Get already-applied versions
    const { rows } = await client.query(`SELECT version FROM ${MIGRATIONS_TABLE}`)
    const applied = new Set(rows.map(r => (r as { version: string }).version))

    for (const migration of filtered) {
      if (applied.has(migration.version)) {
        result.skipped.push({ type: 'sql', label: `v${migration.version}`, reason: 'Already applied' })
        continue
      }

      // Apply SQL statements
      for (const sql of migration.up.sql) {
        if (sql.startsWith('--')) continue // Skip comment-only markers
        try {
          await client.query(sql)
          result.applied.push({ type: 'sql', label: summarizeStatement(sql) })
        } catch (err) {
          result.errors.push({
            type: 'sql',
            label: summarizeStatement(sql),
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }

      // Track migration
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, description) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [migration.version, migration.description],
      )
    }
  } finally {
    await client.end()
  }

  return result
}

// ─── Preview (Dry-Run) ──────────────────────────────────────────────────────

/** Preview what a snapshot restore would apply (no DB connection required). */
export async function previewSnapshotRestore(snapshotDir: string): Promise<{ layer: string; statements: string[] }[]> {
  const manifest = await loadSnapshot(snapshotDir)
  const preview: { layer: string; statements: string[] }[] = []

  const sqlOrder = ['extensions', 'schema', 'rls', 'cron', 'webhooks', 'storage-policies']
  for (const layer of sqlOrder) {
    const file = layerRestoreFile(layer)
    const info = manifest.layers[layer === 'storage-policies' ? 'storage' : layer]
    if (!info?.captured) continue

    try {
      const content = await readFile(join(snapshotDir, file), 'utf-8')
      const statements = extractExecutableStatements(content)
      if (statements.length > 0) {
        preview.push({ layer, statements })
      }
    } catch { /* skip */ }
  }

  return preview
}

/** Preview what migration restore would apply. */
export async function previewMigrationRestore(cwd = process.cwd(), toVersion?: string, fromVersion?: string): Promise<MigrationFile[]> {
  let migrations = await loadMigrations(cwd)
  if (fromVersion) migrations = migrations.filter(m => m.version >= fromVersion)
  if (toVersion) migrations = migrations.filter(m => m.version <= toVersion)
  return migrations
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function layerRestoreFile(layer: string): string {
  switch (layer) {
    case 'extensions': return 'extensions.sql'
    case 'schema': return 'schema.sql'
    case 'rls': return 'rls.sql'
    case 'cron': return 'cron.sql'
    case 'webhooks': return 'webhooks.sql'
    case 'storage-policies': return 'storage-policies.sql'
    default: return `${layer}.sql`
  }
}

function extractExecutableStatements(content: string): string[] {
  if (!content) return []
  // Split by semicolon-followed-by-newline, filtering out comments and empty lines
  return content
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => {
      if (!s) return false
      // Skip pure comment blocks
      const lines = s.split('\n').filter(l => l.trim().length > 0)
      return lines.some(l => !l.trim().startsWith('--'))
    })
    .map(s => s.endsWith(';') ? s : `${s};`)
}

function summarizeStatement(sql: string): string {
  const first = sql.split('\n').find(l => !l.trim().startsWith('--'))?.trim() ?? sql.trim()
  return first.length > 80 ? `${first.slice(0, 77)}...` : first
}
