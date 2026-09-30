import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { MigrationFile, MigrationAction, SnapshotManifest } from './types/config'
import { loadSnapshot, findLatestSnapshot, captureSnapshot, generateTimestamp, type SnapshotOptions, type SnapshotResult } from './snapshot'
import { SUPAFORGE_DIR, MIGRATIONS_SUBDIR } from './constants'
import { splitSqlStatements, isCommentOnly } from './utils/sql-split.js'
import { slugify } from './utils/strings'

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

        // Both directions get the inverse of the other's changes.
        //
        // `up` was the added statements alone and `down` the removed ones, so
        // each direction only did half its job: applying a migration that
        // *removed* a policy did not drop it, and reverting one that *added*
        // a policy left it in place (issue #92). Undoing either is mechanical
        // for these layers — a cron job is unscheduled, a policy, trigger or
        // extension is dropped — and `inverseStatement` returns null rather
        // than guessing for anything else.
        sqlUp.push(...added)
        for (const statement of removed) {
          const inverse = inverseStatement(statement)
          if (inverse) sqlUp.push(inverse)
        }

        sqlDown.push(...removed)
        for (const statement of added) {
          const inverse = inverseStatement(statement)
          if (inverse) sqlDown.push(inverse)
        }
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

  // Compare schema.json (diff by content change)
  try {
    const prevSchema = await readFile(join(previousDir, 'schema.json'), 'utf-8').catch(() => '')
    const newSchema = await readFile(join(snapshot.dir, 'schema.json'), 'utf-8').catch(() => '')
    if (prevSchema !== newSchema) {
      layers.push('schema')
      // No DDL here, and this says so rather than looking like a statement.
      //
      // Deriving a migration from two introspection documents means writing a
      // schema differ, which is what @dbdiff/cli already is — and it wants two
      // live databases, not two JSON files. What this *can* do is say which
      // objects moved, so the reader knows where to look instead of being told
      // only that something changed (issue #92).
      sqlUp.push(...schemaChangeNotes(prevSchema, newSchema))
    }
  } catch { /* skip */ }

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
/**
 * The statements in a snapshot layer file.
 *
 * Split on `;\n` and then discarded any chunk beginning with `--`. Every layer
 * file opens with a `-- SupaForge … Snapshot` header, and that header lands in
 * the same chunk as the *first* statement — so the first statement of every
 * layer was thrown away with it (issue #92). Adding or removing the
 * alphabetically-first cron job, policy, webhook or extension was invisible,
 * and the previous first statement then appeared as newly added.
 *
 * Uses the same scanner `restore` does: it respects dollar-quoted bodies and
 * drops only chunks that are genuinely nothing but comments.
 */
function extractStatements(content: string): string[] {
  if (!content) return []

  return splitSqlStatements(content)
    .filter(statement => !isCommentOnly(statement))
    .map(stripLeadingComments)
    .filter(statement => statement.length > 0)
    .map(statement => statement.endsWith(';') ? statement : `${statement};`)
}

/**
 * A statement without the comment lines above it.
 *
 * The header a layer file opens with carries a count — `-- 2 policies` — and
 * the splitter keeps a comment attached to the statement that follows it. So
 * the first statement of every file would differ between two snapshots
 * whenever the count changed, and be reported as both added and removed even
 * though nothing about it moved. Comparing the SQL alone is what makes the
 * diff mean anything.
 */
function stripLeadingComments(statement: string): string {
  const lines = statement.split('\n')
  let start = 0

  while (start < lines.length) {
    const line = lines[start].trim()
    if (line === '' || line.startsWith('--')) {
      start++
      continue
    }
    break
  }

  return lines.slice(start).join('\n').trim()
}

/**
 * The statement that undoes `statement`, where that is mechanical.
 *
 * Only for the shapes a snapshot layer emits: a scheduled cron job, a policy,
 * a trigger, an extension. Anything else returns null rather than a guess —
 * a wrong inverse in a `down` is worse than an absent one, because it looks
 * like a revert and is not.
 */
export function inverseStatement(statement: string): string | null {
  const sql = statement.trim()

  const cron = /\bcron\.schedule\s*\(\s*('(?:[^']|'')*')/i.exec(sql)
  if (cron) return `SELECT cron.unschedule(${cron[1]});`

  const policy = /\bCREATE\s+POLICY\s+("[^"]+"|[\w$]+)\s+ON\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
  if (policy) return `DROP POLICY IF EXISTS ${policy[1]} ON ${policy[2]};`

  const trigger = /\bCREATE\s+TRIGGER\s+("[^"]+"|[\w$]+)[\s\S]*?\bON\s+((?:"[^"]+"|[\w$]+)(?:\s*\.\s*(?:"[^"]+"|[\w$]+))?)/i.exec(sql)
  if (trigger) return `DROP TRIGGER IF EXISTS ${trigger[1]} ON ${trigger[2]};`

  const extension = /\bCREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?("[^"]+"|[\w$]+)/i.exec(sql)
  if (extension) return `DROP EXTENSION IF EXISTS ${extension[1]};`

  return null
}

/**
 * What changed between two schema introspections, as comment lines.
 *
 * Not SQL, and shaped so it cannot be mistaken for any: the migration's schema
 * layer carries no DDL, and the previous single line — "Schema changed. Use
 * @dbdiff/cli to generate migration SQL." — told the reader nothing about
 * *what* changed (issue #92).
 */
export function schemaChangeNotes(previousJson: string, currentJson: string): string[] {
  const notes = [
    '-- The schema changed. This migration carries no DDL for it: deriving one',
    '-- from two introspection documents is what @dbdiff/cli does, and it needs',
    '-- two live databases. Generate it with `supaforge migrate create`.',
  ]

  try {
    const before = JSON.parse(previousJson) as Record<string, Array<{ schema?: string; name?: string }>>
    const after = JSON.parse(currentJson) as Record<string, Array<{ schema?: string; name?: string }>>

    for (const kind of ['tables', 'views', 'functions', 'triggers', 'sequences', 'enums']) {
      const names = (list?: Array<{ schema?: string; name?: string }>) =>
        new Set((list ?? []).map(o => `${o.schema ?? 'public'}.${o.name ?? '?'}`))

      const from = names(before[kind])
      const to = names(after[kind])

      const added = [...to].filter(n => !from.has(n)).sort()
      const removed = [...from].filter(n => !to.has(n)).sort()

      if (added.length > 0) notes.push(`--   ${kind} added:   ${added.join(', ')}`)
      if (removed.length > 0) notes.push(`--   ${kind} removed: ${removed.join(', ')}`)
    }
  } catch {
    // An unreadable document just means no detail to add.
  }

  return notes
}
