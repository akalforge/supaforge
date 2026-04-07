import { spawn } from 'node:child_process'
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { QueryFn } from './db'
import { pgQuery } from './db'
import type { EnvironmentConfig, SupaForgeConfig, SnapshotManifest, SnapshotLayerInfo } from './types/config'
import { DEFAULT_IGNORE_SCHEMAS } from './defaults'

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

/** Supabase Management API base URL */
const MGMT_API = 'https://api.supabase.com/v1/projects'

/** Directory structure */
const SUPAFORGE_DIR = '.supaforge'
const SNAPSHOTS_DIR = 'snapshots'

export interface SnapshotOptions {
  envName: string
  env: EnvironmentConfig
  config: SupaForgeConfig
  /** Base output directory (defaults to cwd) */
  cwd?: string
  queryFn?: QueryFn
  fetchFn?: FetchFn
}

export interface SnapshotResult {
  manifest: SnapshotManifest
  dir: string
  timestamp: string
}

// ─── Timestamp Helpers ───────────────────────────────────────────────────────

export function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
}

function snapshotsBaseDir(cwd: string): string {
  return resolve(cwd, SUPAFORGE_DIR, SNAPSHOTS_DIR)
}

export function snapshotDir(cwd: string, timestamp: string): string {
  return join(snapshotsBaseDir(cwd), timestamp)
}

// ─── Main Snapshot Function ──────────────────────────────────────────────────

/**
 * Capture a full snapshot of a single Supabase environment.
 * Each layer is exported independently; failures in one layer don't block others.
 */
export async function captureSnapshot(options: SnapshotOptions): Promise<SnapshotResult> {
  const cwd = options.cwd ?? process.cwd()
  const timestamp = generateTimestamp()
  const dir = snapshotDir(cwd, timestamp)
  await mkdir(dir, { recursive: true })

  const queryFn = options.queryFn ?? pgQuery
  const fetchFn = options.fetchFn ?? globalThis.fetch.bind(globalThis)
  const ignoreSchemas = options.config.ignoreSchemas ?? DEFAULT_IGNORE_SCHEMAS

  const layers: Record<string, SnapshotLayerInfo> = {}

  // Layer 1: Schema (pg_dump --schema-only)
  layers.schema = await captureSchema(dir, options.env.dbUrl, ignoreSchemas)

  // Layer 2: RLS Policies
  layers.rls = await captureRlsPolicies(dir, options.env.dbUrl, ignoreSchemas, queryFn)

  // Layer 3: Edge Functions (API)
  layers['edge-functions'] = await captureEdgeFunctions(dir, options.env, fetchFn)

  // Layer 4: Storage (API + DB)
  layers.storage = await captureStorage(dir, options.env, fetchFn, queryFn)

  // Layer 5: Auth Config (API)
  layers.auth = await captureAuthConfig(dir, options.env, fetchFn)

  // Layer 6: Cron Jobs
  layers.cron = await captureCronJobs(dir, options.env.dbUrl, queryFn)

  // Layer 7: Reference Data
  const dataTables = options.config.checks?.data?.tables ?? []
  layers.data = await captureData(dir, options.env.dbUrl, dataTables)

  // Layer 8: Webhooks
  layers.webhooks = await captureWebhooks(dir, options.env.dbUrl, queryFn)

  // Layer 9: Extensions
  layers.extensions = await captureExtensions(dir, options.env.dbUrl, queryFn)

  const manifest: SnapshotManifest = {
    version: 1,
    timestamp,
    environment: options.envName,
    projectRef: options.env.projectRef,
    layers,
  }

  await writeFile(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')

  return { manifest, dir, timestamp }
}

// ─── Layer Capture Functions ─────────────────────────────────────────────────

async function captureSchema(
  dir: string,
  dbUrl: string,
  ignoreSchemas: string[],
): Promise<SnapshotLayerInfo> {
  const file = 'schema.sql'
  try {
    const excludeArgs = ignoreSchemas.flatMap(s => ['--exclude-schema', s])
    const sql = await runPgDump([
      '--schema-only',
      '--no-owner',
      '--no-acl',
      '--no-comments',
      ...excludeArgs,
      dbUrl,
    ])
    await writeFile(join(dir, file), sql)
    const tableCount = (sql.match(/CREATE TABLE/gi) ?? []).length
    return { captured: true, file, itemCount: tableCount }
  } catch {
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureRlsPolicies(
  dir: string,
  dbUrl: string,
  ignoreSchemas: string[],
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'rls.sql'
  try {
    const placeholders = ignoreSchemas.map((_, i) => `$${i + 1}`).join(', ')
    const sql = ignoreSchemas.length > 0
      ? `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
         FROM pg_policies WHERE schemaname NOT IN (${placeholders})
         ORDER BY schemaname, tablename, policyname`
      : `SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
         FROM pg_policies ORDER BY schemaname, tablename, policyname`

    const rows = await queryFn(dbUrl, sql, ignoreSchemas.length > 0 ? ignoreSchemas : undefined) as unknown as RlsRow[]
    const statements = rows.map(p => generateCreatePolicySql(p))
    const output = statements.length > 0
      ? `-- SupaForge RLS Policy Snapshot\n-- ${rows.length} policies\n\n${statements.join('\n\n')}\n`
      : '-- No RLS policies found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch {
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureEdgeFunctions(
  dir: string,
  env: EnvironmentConfig,
  fetchFn: FetchFn,
): Promise<SnapshotLayerInfo> {
  const file = 'edge-functions.json'
  if (!env.projectRef || !env.apiKey) {
    return { captured: false, file, itemCount: 0 }
  }

  try {
    const url = `${MGMT_API}/${encodeURIComponent(env.projectRef)}/functions`
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${env.apiKey}` },
    })
    if (!res.ok) throw new Error(res.statusText)
    const functions = await res.json() as unknown[]
    await writeFile(join(dir, file), JSON.stringify(functions, null, 2) + '\n')
    return { captured: true, file, itemCount: functions.length }
  } catch {
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureStorage(
  dir: string,
  env: EnvironmentConfig,
  fetchFn: FetchFn,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  let bucketCount = 0
  let policyCount = 0

  // Buckets via API
  const bucketsFile = 'storage-buckets.json'
  if ((env.projectRef || env.apiUrl) && env.apiKey) {
    try {
      const base = env.apiUrl
        ? `${env.apiUrl}/storage/v1`
        : `https://${encodeURIComponent(env.projectRef!)}.supabase.co/storage/v1`
      const res = await fetchFn(`${base}/bucket`, {
        headers: { Authorization: `Bearer ${env.apiKey}`, apikey: env.apiKey },
      })
      if (res.ok) {
        const buckets = await res.json() as unknown[]
        await writeFile(join(dir, bucketsFile), JSON.stringify(buckets, null, 2) + '\n')
        bucketCount = buckets.length
      }
    } catch { /* skip */ }
  }

  // Storage policies via DB
  const policiesFile = 'storage-policies.sql'
  try {
    const rows = await queryFn(env.dbUrl, `
      SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
      FROM pg_policies WHERE schemaname = 'storage'
      ORDER BY tablename, policyname
    `)
    const statements = (rows as unknown as StoragePolicyRow[]).map(p => generateStorageCreatePolicySql(p))
    const output = statements.length > 0
      ? `-- SupaForge Storage Policy Snapshot\n-- ${rows.length} policies\n\n${statements.join('\n\n')}\n`
      : '-- No storage policies found\n'
    await writeFile(join(dir, policiesFile), output)
    policyCount = rows.length
  } catch { /* skip */ }

  return {
    captured: bucketCount > 0 || policyCount > 0,
    file: bucketsFile,
    itemCount: bucketCount + policyCount,
  }
}

async function captureAuthConfig(
  dir: string,
  env: EnvironmentConfig,
  fetchFn: FetchFn,
): Promise<SnapshotLayerInfo> {
  const file = 'auth.json'
  if (!env.projectRef || !env.apiKey) {
    return { captured: false, file, itemCount: 0 }
  }

  try {
    const url = `${MGMT_API}/${encodeURIComponent(env.projectRef)}/config/auth`
    const res = await fetchFn(url, {
      headers: { Authorization: `Bearer ${env.apiKey}` },
    })
    if (!res.ok) throw new Error(res.statusText)
    const config = await res.json() as Record<string, unknown>
    await writeFile(join(dir, file), JSON.stringify(config, null, 2) + '\n')
    return { captured: true, file, itemCount: Object.keys(config).length }
  } catch {
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureCronJobs(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'cron.sql'
  try {
    const rows = await queryFn(dbUrl, `
      SELECT jobid, schedule, command, nodename, nodeport, database, username, active, jobname
      FROM cron.job ORDER BY jobname, jobid
    `)
    const statements = (rows as unknown as CronRow[]).map(job => {
      const name = job.jobname ?? `job-${job.jobid}`
      return `SELECT cron.schedule('${name}', '${job.schedule}', $$${job.command}$$);`
    })
    const output = statements.length > 0
      ? `-- SupaForge Cron Job Snapshot\n-- ${rows.length} jobs\n\n${statements.join('\n\n')}\n`
      : '-- No cron jobs found (pg_cron may not be installed)\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch {
    // pg_cron not installed
    await writeFile(join(dir, file), '-- pg_cron extension not available\n')
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureData(
  dir: string,
  dbUrl: string,
  tables: string[],
): Promise<SnapshotLayerInfo> {
  if (tables.length === 0) {
    return { captured: false, file: 'data/', itemCount: 0 }
  }

  const dataDir = join(dir, 'data')
  await mkdir(dataDir, { recursive: true })
  let captured = 0

  for (const table of tables) {
    try {
      const sql = await runPgDump([
        '--data-only',
        '--no-owner',
        '--no-acl',
        `--table=${table}`,
        dbUrl,
      ])
      await writeFile(join(dataDir, `${table}.sql`), sql)
      captured++
    } catch { /* skip individual table failures */ }
  }

  return { captured: captured > 0, file: 'data/', itemCount: captured }
}

async function captureWebhooks(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'webhooks.sql'
  try {
    const rows = await queryFn(dbUrl, `
      SELECT
        h.id, h.hook_table_id, h.hook_name, h.created_at, h.request_id,
        pg_get_functiondef(t.tgfoid) AS function_body,
        CASE
          WHEN t.tgtype::int & 4 > 0 AND t.tgtype::int & 8 > 0 AND t.tgtype::int & 16 > 0
            THEN 'INSERT OR UPDATE OR DELETE'
          WHEN t.tgtype::int & 4 > 0 AND t.tgtype::int & 8 > 0
            THEN 'INSERT OR UPDATE'
          WHEN t.tgtype::int & 4 > 0 AND t.tgtype::int & 16 > 0
            THEN 'INSERT OR DELETE'
          WHEN t.tgtype::int & 8 > 0 AND t.tgtype::int & 16 > 0
            THEN 'UPDATE OR DELETE'
          WHEN t.tgtype::int & 4 > 0 THEN 'INSERT'
          WHEN t.tgtype::int & 8 > 0 THEN 'UPDATE'
          WHEN t.tgtype::int & 16 > 0 THEN 'DELETE'
          ELSE NULL
        END AS events,
        (n.nspname || '.' || c.relname) AS trigger_table
      FROM supabase_functions.hooks h
      LEFT JOIN pg_trigger t ON t.tgname = h.hook_name
      LEFT JOIN pg_class c ON c.oid = t.tgrelid
      LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
      ORDER BY h.hook_name, h.id
    `)

    const statements = (rows as unknown as WebhookRow[])
      .filter(h => h.function_body && h.events && h.trigger_table)
      .map(hook => {
        return [
          `-- Webhook: ${hook.hook_name}`,
          `${hook.function_body};`,
          '',
          `CREATE TRIGGER "${hook.hook_name}"`,
          `  AFTER ${hook.events}`,
          `  ON ${hook.trigger_table}`,
          `  FOR EACH ROW`,
          `  EXECUTE FUNCTION supabase_functions.http_request();`,
        ].join('\n')
      })

    const output = statements.length > 0
      ? `-- SupaForge Webhook Snapshot\n-- ${statements.length} webhooks\n\n${statements.join('\n\n')}\n`
      : '-- No webhooks found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: statements.length }
  } catch {
    await writeFile(join(dir, file), '-- supabase_functions schema not available\n')
    return { captured: false, file, itemCount: 0 }
  }
}

async function captureExtensions(
  dir: string,
  dbUrl: string,
  queryFn: QueryFn,
): Promise<SnapshotLayerInfo> {
  const file = 'extensions.sql'
  try {
    const rows = await queryFn(dbUrl, `
      SELECT extname, extversion, n.nspname AS schema
      FROM pg_extension e
      JOIN pg_namespace n ON n.oid = e.extnamespace
      ORDER BY extname
    `)
    const statements = (rows as unknown as { extname: string; extversion: string; schema: string }[]).map(ext => {
      return `CREATE EXTENSION IF NOT EXISTS "${ext.extname}" WITH SCHEMA "${ext.schema}";`
    })
    const output = statements.length > 0
      ? `-- SupaForge Extensions Snapshot\n-- ${rows.length} extensions\n\n${statements.join('\n')}\n`
      : '-- No extensions found\n'
    await writeFile(join(dir, file), output)
    return { captured: true, file, itemCount: rows.length }
  } catch {
    return { captured: false, file, itemCount: 0 }
  }
}

// ─── Snapshot Reading ────────────────────────────────────────────────────────

/** Load the manifest from a snapshot directory. */
export async function loadSnapshot(dir: string): Promise<SnapshotManifest> {
  const raw = await readFile(join(dir, 'manifest.json'), 'utf-8')
  return JSON.parse(raw) as SnapshotManifest
}

/** Find the latest snapshot directory. */
export async function findLatestSnapshot(cwd = process.cwd()): Promise<string | null> {
  const base = snapshotsBaseDir(cwd)
  try {
    const entries = await readdir(base)
    const sorted = entries.filter(e => /^\d{8}T\d{6}Z$/.test(e)).sort()
    return sorted.length > 0 ? join(base, sorted[sorted.length - 1]) : null
  } catch {
    return null
  }
}

/** List all snapshot directories with their manifests. */
export async function listSnapshots(cwd = process.cwd()): Promise<{ dir: string; manifest: SnapshotManifest }[]> {
  const base = snapshotsBaseDir(cwd)
  try {
    const entries = await readdir(base)
    const sorted = entries.filter(e => /^\d{8}T\d{6}Z$/.test(e)).sort()
    const results: { dir: string; manifest: SnapshotManifest }[] = []
    for (const entry of sorted) {
      try {
        const manifest = await loadSnapshot(join(base, entry))
        results.push({ dir: join(base, entry), manifest })
      } catch { /* skip corrupt snapshots */ }
    }
    return results
  } catch {
    return []
  }
}

// ─── pg_dump Helper ──────────────────────────────────────────────────────────

function runPgDump(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn('pg_dump', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    proc.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(chunks).toString('utf-8'))
      } else {
        reject(new Error(`pg_dump failed (exit ${code}): ${stderr}`))
      }
    })
    proc.on('error', reject)
  })
}

// ─── SQL Generation Helpers (reused from checks) ────────────────────────────

interface RlsRow {
  schemaname: string
  tablename: string
  policyname: string
  permissive: string
  roles: string[] | string
  cmd: string
  qual: string | null
  with_check: string | null
}

function normalizeRoles(roles: string[] | string): string {
  if (Array.isArray(roles)) return roles.join(', ')
  if (typeof roles === 'string' && roles.startsWith('{') && roles.endsWith('}')) {
    return roles.slice(1, -1).split(',').join(', ')
  }
  return String(roles)
}

function generateCreatePolicySql(p: RlsRow): string {
  const roles = normalizeRoles(p.roles)
  const lines = [
    `CREATE POLICY "${p.policyname}"`,
    `  ON "${p.schemaname}"."${p.tablename}"`,
    `  AS ${p.permissive}`,
    `  FOR ${p.cmd}`,
    `  TO ${roles}`,
  ]
  if (p.qual) lines.push(`  USING (${p.qual})`)
  if (p.with_check) lines.push(`  WITH CHECK (${p.with_check})`)
  lines.push(';')
  return lines.join('\n')
}

interface StoragePolicyRow {
  tablename: string
  policyname: string
  permissive: string
  roles: string[] | string
  cmd: string
  qual: string | null
  with_check: string | null
}

function generateStorageCreatePolicySql(p: StoragePolicyRow): string {
  const roles = normalizeRoles(p.roles)
  const lines = [
    `CREATE POLICY "${p.policyname}"`,
    `  ON "storage"."${p.tablename}"`,
    `  AS ${p.permissive}`,
    `  FOR ${p.cmd}`,
    `  TO ${roles}`,
  ]
  if (p.qual) lines.push(`  USING (${p.qual})`)
  if (p.with_check) lines.push(`  WITH CHECK (${p.with_check})`)
  lines.push(';')
  return lines.join('\n')
}

interface CronRow {
  jobid: number
  schedule: string
  command: string
  jobname: string | null
}

interface WebhookRow {
  hook_name: string
  function_body: string | null
  events: string | null
  trigger_table: string | null
}
