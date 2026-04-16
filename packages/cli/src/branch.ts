import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import pg from 'pg'
import { captureSnapshot, type SnapshotResult } from './snapshot'
import type { EnvironmentConfig, SupaForgeConfig } from './types/config'
import { checkPgDumpCompat } from './pg-tools'
import { BRANCHES_FILE, PG_PIPELINE_TIMEOUT_MS, CLONE_PROGRESS_INTERVAL_MS } from './constants'
import { CLONE_STUBS_SQL } from './stubs'

/** Prefix for branch database names created by SupaForge. */
export const BRANCH_DB_PREFIX = 'supaforge_branch_'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BranchMeta {
  name: string
  dbName: string
  dbUrl: string
  createdFrom: string
  createdAt: string
  schemaOnly: boolean
  /** Directory containing the layer snapshot taken at branch creation time. */
  snapshotDir?: string
}

export interface BranchesManifest {
  branches: BranchMeta[]
}

export interface CreateBranchOptions {
  /** Branch name (must be unique). Converted to a safe DB identifier. */
  name: string
  /** Connection URL of the database to branch from. */
  sourceUrl: string
  /** Human-readable label for where we branched from (e.g. "production"). */
  sourceLabel: string
  /** If true, copy schema only (no data). */
  schemaOnly?: boolean
  /** Working directory for .supaforge/ metadata. */
  cwd?: string
  /** Capture a full snapshot alongside the DB clone. */
  env?: EnvironmentConfig
  /** Config needed for snapshot (ignore schemas, data tables, etc.). */
  config?: SupaForgeConfig
}

export interface BranchDiffSummary {
  branch: string
  against: string
  tables: number
  added: string[]
  removed: string[]
  modified: string[]
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Sanitise a branch name into a valid Postgres identifier. */
export function branchDbName(name: string): string {
  const safe = name
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
  if (!safe) throw new Error(`Invalid branch name: "${name}"`)
  return `${BRANCH_DB_PREFIX}${safe}`
}

/** Build a connection URL pointing at a different database on the same server. */
export function replaceDbName(sourceUrl: string, dbName: string): string {
  const u = new URL(sourceUrl)
  u.pathname = `/${dbName}`
  return u.toString()
}

/** Parse connection URL to extract components. */
function parseUrl(url: string) {
  const u = new URL(url)
  return {
    host: u.hostname,
    port: u.port || '5432',
    user: u.username,
    password: u.password,
    database: u.pathname.replace(/^\//, ''),
  }
}

// ─── Manifest I/O ────────────────────────────────────────────────────────────

async function manifestPath(cwd: string): Promise<string> {
  return resolve(cwd, BRANCHES_FILE)
}

export async function loadManifest(cwd = process.cwd()): Promise<BranchesManifest> {
  try {
    const raw = await readFile(await manifestPath(cwd), 'utf-8')
    return JSON.parse(raw) as BranchesManifest
  } catch {
    return { branches: [] }
  }
}

async function saveManifest(manifest: BranchesManifest, cwd: string): Promise<void> {
  const p = await manifestPath(cwd)
  await mkdir(dirname(p), { recursive: true })
  await writeFile(p, JSON.stringify(manifest, null, 2) + '\n')
}

// ─── Branch Operations ───────────────────────────────────────────────────────

/**
 * Create a branch by copying the source database.
 *
 * Strategy:
 *  1. Try `CREATE DATABASE ... TEMPLATE` (instant, requires no other connections).
 *  2. Fall back to `pg_dump | pg_restore` (works for remote / busy databases).
 */
export async function createBranch(opts: CreateBranchOptions): Promise<BranchMeta> {
  const cwd = opts.cwd ?? process.cwd()
  const dbName = branchDbName(opts.name)
  const branchUrl = replaceDbName(opts.sourceUrl, dbName)

  // Check for duplicate
  const manifest = await loadManifest(cwd)
  if (manifest.branches.some(b => b.name === opts.name)) {
    throw new Error(`Branch "${opts.name}" already exists.`)
  }

  const created = await tryTemplateCopy(opts.sourceUrl, dbName)
  let pgDumpPath = 'pg_dump'
  let pgRestorePath = 'pg_restore'
  if (!created) {
    // Template copy failed — need pg_dump pipeline. Check compatibility first.
    const compat = await checkPgDumpCompat(opts.sourceUrl)
    if (!compat.compatible) {
      throw new Error(compat.message)
    }
    pgDumpPath = compat.pgDumpPath
    pgRestorePath = compat.pgRestorePath
  }

  const dumpCreated = created || await tryDumpRestore(opts.sourceUrl, dbName, opts.schemaOnly ?? false, pgDumpPath, pgRestorePath)

  if (!dumpCreated) {
    throw new Error(
      'Failed to create branch. Ensure you have CREATE DATABASE privileges and ' +
      'that pg_dump + pg_restore are available in your PATH.',
    )
  }

  const meta: BranchMeta = {
    name: opts.name,
    dbName,
    dbUrl: branchUrl,
    createdFrom: opts.sourceLabel,
    createdAt: new Date().toISOString(),
    schemaOnly: opts.schemaOnly ?? false,
  }

  // Capture a layer snapshot if environment + config provided
  if (opts.env && opts.config) {
    try {
      const snapshot = await captureSnapshot({
        envName: opts.sourceLabel,
        env: opts.env,
        config: opts.config,
        cwd,
      })
      meta.snapshotDir = snapshot.dir
    } catch {
      // Non-fatal: branch still works without snapshot
    }
  }

  manifest.branches.push(meta)
  await saveManifest(manifest, cwd)
  return meta
}

/** Strategy 1: `CREATE DATABASE ... TEMPLATE source` (fast but exclusive). */
async function tryTemplateCopy(sourceUrl: string, newDb: string): Promise<boolean> {
  const { database } = parseUrl(sourceUrl)
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')
  const client = new pg.Client({ connectionString: maintenanceUrl })
  try {
    await client.connect()
    await client.query(`CREATE DATABASE "${newDb}" TEMPLATE "${database}"`)
    return true
  } catch {
    return false
  } finally {
    await client.end()
  }
}

/** Strategy 2: `pg_dump | pg_restore` (works for busy / remote databases). */
async function tryDumpRestore(
  sourceUrl: string,
  newDb: string,
  schemaOnly: boolean,
  pgDumpPath = 'pg_dump',
  pgRestorePath = 'pg_restore',
): Promise<boolean> {
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')

  // Create the empty target database
  const client = new pg.Client({ connectionString: maintenanceUrl })
  try {
    await client.connect()
    await client.query(`CREATE DATABASE "${newDb}"`)
  } catch {
    return false
  } finally {
    await client.end()
  }

  const dumpArgs = ['--format=custom', '--no-owner', '--no-acl', sourceUrl]
  if (schemaOnly) dumpArgs.unshift('--schema-only')

  const targetUrl = replaceDbName(sourceUrl, newDb)
  const restoreArgs = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--dbname=${targetUrl}`,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      const dump = spawn(pgDumpPath, dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const restore = spawn(pgRestorePath, restoreArgs, { stdio: [dump.stdout, 'pipe', 'pipe'] })

      let restoreStderr = ''
      restore.stderr?.on('data', (chunk: Buffer) => { restoreStderr += chunk.toString() })

      let dumpError = ''
      dump.stderr?.on('data', (chunk: Buffer) => { dumpError += chunk.toString() })

      let dumpExit: number | null = null
      let restoreExit: number | null = null
      let settled = false

      function tryResolve() {
        if (settled || dumpExit === null || restoreExit === null) return
        settled = true
        // pg_dump exit 0 required; pg_restore exit 0 or 1 (warnings) acceptable
        if (dumpExit !== 0) {
          reject(new Error(`pg_dump failed (exit ${dumpExit}): ${dumpError}`))
        } else if (restoreExit !== 0 && restoreExit !== 1) {
          reject(new Error(`pg_restore failed (exit ${restoreExit}): ${restoreStderr}`))
        } else {
          resolve()
        }
      }

      dump.on('close', (code) => { dumpExit = code ?? 1; tryResolve() })
      restore.on('close', (code) => { restoreExit = code ?? 1; tryResolve() })
      dump.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
      restore.on('error', (err) => { if (!settled) { settled = true; reject(err) } })
    })
    return true
  } catch {
    // Clean up on hard failure
    const cleanup = new pg.Client({ connectionString: maintenanceUrl })
    try {
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS "${newDb}"`)
    } finally {
      await cleanup.end()
    }
    return false
  }
}

/** List all tracked branches. */
export async function listBranches(cwd = process.cwd()): Promise<BranchMeta[]> {
  const manifest = await loadManifest(cwd)
  return manifest.branches
}

/** Delete a branch: drop the database and remove from manifest. */
export async function deleteBranch(
  name: string,
  sourceUrl: string,
  cwd = process.cwd(),
): Promise<void> {
  const manifest = await loadManifest(cwd)
  const idx = manifest.branches.findIndex(b => b.name === name)
  if (idx === -1) throw new Error(`Branch "${name}" not found.`)

  const branch = manifest.branches[idx]

  // Terminate connections and drop
  const maintenanceUrl = replaceDbName(sourceUrl, 'postgres')
  const client = new pg.Client({ connectionString: maintenanceUrl })
  try {
    await client.connect()
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [branch.dbName],
    )
    await client.query(`DROP DATABASE IF EXISTS "${branch.dbName}"`)
  } finally {
    await client.end()
  }

  manifest.branches.splice(idx, 1)
  await saveManifest(manifest, cwd)
}

// ─── Remote → Local Clone ────────────────────────────────────────────────────

export interface CloneProgress {
  /** Bytes transferred through the pg_dump → pg_restore pipe. */
  bytesTransferred: number
  /** Milliseconds elapsed since the pipeline started. */
  elapsedMs: number
  /** Most recent pg_restore status message (if any). */
  lastRestoreMessage?: string
}

export interface CloneRemoteOptions {
  /** Remote (source) database connection URL. */
  remoteUrl: string
  /** Local PostgreSQL base URL (e.g. postgres://postgres:postgres@localhost:5432/postgres). */
  localBaseUrl: string
  /** Database name to create locally. */
  localDbName: string
  /** Copy schema only (no data). */
  schemaOnly?: boolean
  /** Drop and recreate the target database if it already exists. */
  force?: boolean
  /** Called periodically with pipeline progress. */
  onProgress?: (info: CloneProgress) => void
  /** Schemas to exclude from pg_dump (e.g. Supabase internals). */
  excludeSchemas?: string[]
}

/**
 * Clone a remote database to a local PostgreSQL server via `pg_dump | pg_restore`.
 *
 * Unlike `createBranch` (which works on a single server), this dumps from one
 * server and restores to another — the typical remote → local workflow.
 *
 * Returns the local database URL on success.
 */
export async function cloneRemoteToLocal(opts: CloneRemoteOptions): Promise<string> {
  const compat = await checkPgDumpCompat(opts.remoteUrl)
  if (!compat.compatible) {
    throw new Error(compat.message)
  }

  const localMaintenanceUrl = opts.localBaseUrl
  const localDbUrl = replaceDbName(opts.localBaseUrl, opts.localDbName)

  // Create the empty target database on the local server
  const client = new pg.Client({ connectionString: localMaintenanceUrl })
  try {
    await client.connect()

    // If --force, drop the existing database first
    if (opts.force) {
      await client.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [opts.localDbName],
      )
      await client.query(`DROP DATABASE IF EXISTS "${opts.localDbName}"`)
    }

    await client.query(`CREATE DATABASE "${opts.localDbName}"`)
  } catch (err) {
    const msg = (err as Error).message ?? ''
    if (msg.includes('already exists')) {
      throw new Error(
        `Database "${opts.localDbName}" already exists on the local server. ` +
        `Drop it first with: psql "${localMaintenanceUrl}" -c 'DROP DATABASE "${opts.localDbName}"'`,
      )
    }
    throw new Error(`Failed to create local database: ${msg}`)
  } finally {
    await client.end()
  }

  // Create Supabase auth + storage stubs BEFORE pg_restore.
  // Without these, pg_restore silently skips FK constraints referencing
  // auth.users and RLS policies referencing auth.uid() — causing false
  // drift on the very first `supaforge diff` after clone.
  if (opts.excludeSchemas?.length) {
    const stubClient = new pg.Client({ connectionString: localDbUrl })
    try {
      await stubClient.connect()
      await stubClient.query(CLONE_STUBS_SQL)
    } finally {
      await stubClient.end()
    }
  }

  // pg_dump from remote | pg_restore to local
  const dumpArgs = ['--format=custom', '--no-owner', '--no-acl']
  if (opts.schemaOnly) dumpArgs.push('--schema-only')

  // Exclude Supabase-internal schemas that reference extensions unavailable on vanilla Postgres
  if (opts.excludeSchemas?.length) {
    for (const schema of opts.excludeSchemas) {
      dumpArgs.push(`--exclude-schema=${schema}`)
    }
  }

  dumpArgs.push(opts.remoteUrl)

  const restoreArgs = [
    '--format=custom',
    '--no-owner',
    '--no-acl',
    `--dbname=${localDbUrl}`,
  ]

  try {
    await new Promise<void>((resolve, reject) => {
      const dump = spawn(compat.pgDumpPath, dumpArgs, { stdio: ['ignore', 'pipe', 'pipe'] })
      const restore = spawn(compat.pgRestorePath, restoreArgs, { stdio: ['pipe', 'pipe', 'pipe'] })

      // Manual pipe so we can count bytes flowing through
      let bytesTransferred = 0
      dump.stdout.on('data', (chunk: Buffer) => { bytesTransferred += chunk.length })
      dump.stdout.pipe(restore.stdin)

      let restoreStderr = ''
      let lastRestoreMessage = ''
      restore.stderr?.on('data', (chunk: Buffer) => {
        restoreStderr += chunk.toString()
        // Extract last meaningful line for progress display
        const lines = chunk.toString().split('\n').filter(Boolean)
        if (lines.length > 0) {
          lastRestoreMessage = lines[lines.length - 1].trim().slice(0, 120)
        }
      })

      let dumpError = ''
      dump.stderr?.on('data', (chunk: Buffer) => { dumpError += chunk.toString() })

      // Progress reporting
      const startTime = Date.now()
      const progressInterval = opts.onProgress
        ? setInterval(() => {
            opts.onProgress!({
              bytesTransferred,
              elapsedMs: Date.now() - startTime,
              lastRestoreMessage: lastRestoreMessage || undefined,
            })
          }, CLONE_PROGRESS_INTERVAL_MS)
        : null

      let dumpExit: number | null = null
      let restoreExit: number | null = null
      let settled = false

      const cleanup = () => {
        if (progressInterval) clearInterval(progressInterval)
        clearTimeout(timeout)
      }

      const trySettle = () => {
        if (settled || dumpExit === null || restoreExit === null) return
        settled = true
        cleanup()
        // Final progress update
        opts.onProgress?.({
          bytesTransferred,
          elapsedMs: Date.now() - startTime,
          lastRestoreMessage: undefined,
        })
        if (dumpExit !== 0) {
          reject(new Error(`pg_dump failed (exit ${dumpExit}): ${dumpError}`))
        } else if (restoreExit !== 0 && restoreExit !== 1) {
          // exit 1 = warnings (expected with extensions) — treat as success
          reject(new Error(`pg_restore failed (exit ${restoreExit}): ${restoreStderr}`))
        } else {
          resolve()
        }
      }

      dump.on('close', (code) => { dumpExit = code ?? 1; trySettle() })
      restore.on('close', (code) => { restoreExit = code ?? 1; trySettle() })
      dump.on('error', (err) => { if (!settled) { settled = true; cleanup(); reject(err) } })
      restore.on('error', (err) => { if (!settled) { settled = true; cleanup(); reject(err) } })

      // Safety timeout — 30 minutes for large databases
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true
          cleanup()
          dump.kill()
          restore.kill()
          reject(new Error(
            'pg_dump | pg_restore timed out after 30 minutes.\n' +
            (dumpError ? `  pg_dump stderr: ${dumpError.slice(0, 500)}\n` : '') +
            (restoreStderr ? `  pg_restore stderr: ${restoreStderr.slice(0, 500)}` : ''),
          ))
        }
      }, PG_PIPELINE_TIMEOUT_MS)
    })
  } catch (err) {
    // Clean up the empty database on failure
    const cleanup = new pg.Client({ connectionString: localMaintenanceUrl })
    try {
      await cleanup.connect()
      await cleanup.query(`DROP DATABASE IF EXISTS "${opts.localDbName}"`)
    } catch { /* best effort */ } finally {
      await cleanup.end()
    }
    throw err
  }

  return localDbUrl
}
