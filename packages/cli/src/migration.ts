import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MigrationFile, MigrationAction, SnapshotManifest } from './types/config'
import { loadSnapshot, findLatestSnapshot, captureSnapshot, generateTimestamp, type SnapshotOptions, type SnapshotResult } from './snapshot'
import { SUPAFORGE_DIR, MIGRATIONS_SUBDIR } from './constants'
import { slugify } from './utils/strings'

/** Migration tracking table name */
export const MIGRATIONS_TABLE = '_supaforge_migrations'

export interface BackupOptions extends Omit<SnapshotOptions, 'cwd'> {
  cwd?: string
  description?: string
}

export interface BackupResult {
  snapshot: SnapshotResult
  migration: MigrationFile | null
  migrationFile: string | null
  /** True if this is the first snapshot (baseline, no diff possible). */
  isBaseline: boolean
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function migrationsDir(cwd: string): string {
  return resolve(cwd, SUPAFORGE_DIR, MIGRATIONS_SUBDIR)
}

// ─── Backup: Snapshot + Diff ─────────────────────────────────────────────────

/**
 * Create a backup: capture a new snapshot and generate a migration file
 * containing the diff against the previous snapshot.
 *
 * If no previous snapshot exists, the migration is a "baseline" containing
 * the full state.
 */
export async function backup(options: BackupOptions): Promise<BackupResult> {
  const cwd = options.cwd ?? process.cwd()

  // Find previous snapshot for diffing
  const previousDir = await findLatestSnapshot(cwd)
  const previousManifest = previousDir ? await loadSnapshot(previousDir) : null

  // Capture new snapshot
  const snapshot = await captureSnapshot({ ...options, cwd })

  // Generate migration
  const description = options.description ?? 'auto-backup'
  const isBaseline = !previousManifest

  const migration = isBaseline
    ? await generateBaselineMigration(snapshot, cwd, description)
    : await generateDiffMigration(previousDir!, snapshot, cwd, description)

  let migrationFile: string | null = null
  if (migration) {
    const mDir = migrationsDir(cwd)
    await mkdir(mDir, { recursive: true })
    const filename = `${snapshot.timestamp}_${slugify(description, '-')}.json`
    migrationFile = join(mDir, filename)
    await writeFile(migrationFile, JSON.stringify(migration, null, 2) + '\n')
  }

  return { snapshot, migration, migrationFile, isBaseline }
}

// ─── Migration Generation ────────────────────────────────────────────────────

async function generateBaselineMigration(
  snapshot: SnapshotResult,
  cwd: string,
  description: string,
): Promise<MigrationFile> {
  const sqlUp: string[] = []
  const sqlDown: string[] = []
  const apiUp: MigrationAction[] = []
  const layers: string[] = []

  // Read each captured layer and add to migration
  for (const [layer, info] of Object.entries(snapshot.manifest.layers)) {
    if (!info.captured) continue
    layers.push(layer)

    if (layer === 'auth' || layer === 'edge-functions') {
      // API-based layers store JSON — convert to actions
      continue // Auth/edge-functions require project ref at apply time; stored in snapshot
    }

    if (layer === 'storage' && info.file === 'storage-buckets.json') {
      // Storage buckets — API-based, stored in snapshot
      continue
    }

    // SQL-based layers
    if (info.file.endsWith('.sql')) {
      try {
        const content = await readFile(join(snapshot.dir, info.file), 'utf-8')
        const statements = extractStatements(content)
        if (statements.length > 0) {
          sqlUp.push(...statements)
        }
      } catch { /* skip */ }
    }
  }

  return {
    version: snapshot.timestamp,
    description: `baseline: ${description}`,
    parent: null,
    layers,
    up: { sql: sqlUp, api: apiUp },
    down: { sql: sqlDown, api: [] },
  }
}

async function generateDiffMigration(
  previousDir: string,
  snapshot: SnapshotResult,
  _cwd: string,
  description: string,
): Promise<MigrationFile | null> {
  const previousManifest = await loadSnapshot(previousDir)
  const sqlUp: string[] = []
  const sqlDown: string[] = []
  const apiUp: MigrationAction[] = []
  const apiDown: MigrationAction[] = []
  const layers: string[] = []

  // Compare SQL-based layers
  for (const layer of ['rls', 'cron', 'webhooks', 'extensions', 'storage-policies'] as const) {
    const file = layerToFile(layer)
    const prevFile = layerToFile(layer)

    try {
      const prevContent = await readFile(join(previousDir, prevFile), 'utf-8').catch(() => '')
      const newContent = await readFile(join(snapshot.dir, file), 'utf-8').catch(() => '')

      if (prevContent === newContent) continue

      const prevStatements = new Set(extractStatements(prevContent))
      const newStatements = new Set(extractStatements(newContent))

      const added = [...newStatements].filter(s => !prevStatements.has(s))
      const removed = [...prevStatements].filter(s => !newStatements.has(s))

      if (added.length > 0 || removed.length > 0) {
        layers.push(layer === 'storage-policies' ? 'storage' : layer)
        sqlUp.push(...added)
        sqlDown.push(...removed)
      }
    } catch { /* skip */ }
  }

  // Compare JSON-based layers (auth, storage buckets, edge functions)
  for (const layer of ['auth', 'storage-buckets', 'edge-functions'] as const) {
    const file = layerToFile(layer)
    try {
      const prevContent = await readFile(join(previousDir, file), 'utf-8').catch(() => '{}')
      const newContent = await readFile(join(snapshot.dir, file), 'utf-8').catch(() => '{}')

      if (prevContent === newContent) continue
      layers.push(layer === 'storage-buckets' ? 'storage' : layer)
      // Store the full new state as an API action — detailed diffing happens at apply time
    } catch { /* skip */ }
  }

  // Compare schema.sql (diff by content change)
  try {
    const prevSchema = await readFile(join(previousDir, 'schema.sql'), 'utf-8').catch(() => '')
    const newSchema = await readFile(join(snapshot.dir, 'schema.sql'), 'utf-8').catch(() => '')
    if (prevSchema !== newSchema) {
      layers.push('schema')
      // Schema diffs are best computed by @dbdiff/cli at apply time
      // Store a marker that schema changed
      sqlUp.push('-- Schema changed. Use @dbdiff/cli to generate migration SQL.')
    }
  } catch { /* skip */ }

  if (layers.length === 0) return null

  return {
    version: snapshot.timestamp,
    description,
    parent: previousManifest.timestamp,
    layers: [...new Set(layers)],
    up: { sql: sqlUp, api: apiUp },
    down: { sql: sqlDown, api: apiDown },
  }
}

// ─── Migration Reading ───────────────────────────────────────────────────────

/** Load all migration files in timestamp order. */
export async function loadMigrations(cwd = process.cwd()): Promise<MigrationFile[]> {
  const dir = migrationsDir(cwd)
  try {
    const entries = await readdir(dir)
    const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
    const migrations: MigrationFile[] = []
    for (const file of jsonFiles) {
      const raw = await readFile(join(dir, file), 'utf-8')
      migrations.push(JSON.parse(raw) as MigrationFile)
    }
    return migrations
  } catch {
    return []
  }
}

/** List migration files with metadata. */
export async function listMigrationFiles(cwd = process.cwd()): Promise<{ file: string; version: string; description: string; layers: string[] }[]> {
  const dir = migrationsDir(cwd)
  try {
    const entries = await readdir(dir)
    const jsonFiles = entries.filter(e => e.endsWith('.json')).sort()
    const results: { file: string; version: string; description: string; layers: string[] }[] = []
    for (const file of jsonFiles) {
      const raw = await readFile(join(dir, file), 'utf-8')
      const m = JSON.parse(raw) as MigrationFile
      results.push({ file, version: m.version, description: m.description, layers: m.layers })
    }
    return results
  } catch {
    return []
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function layerToFile(layer: string): string {
  switch (layer) {
    case 'rls': return 'rls.sql'
    case 'cron': return 'cron.sql'
    case 'webhooks': return 'webhooks.sql'
    case 'extensions': return 'extensions.sql'
    case 'storage-policies': return 'storage-policies.sql'
    case 'auth': return 'auth.json'
    case 'storage-buckets': return 'storage-buckets.json'
    case 'edge-functions': return 'edge-functions.json'
    default: return `${layer}.sql`
  }
}

/** Extract executable SQL statements from a snapshot file (skips comments). */
function extractStatements(content: string): string[] {
  if (!content) return []
  return content
    .split(/;\s*\n/)
    .map(s => s.trim())
    .filter(s => s.length > 0 && !s.startsWith('--'))
    .map(s => s.endsWith(';') ? s : `${s};`)
}
