import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue, SyncAction } from '../types/drift'
import { sqlLiteral } from '../utils/sql'
import { normalizeRoles } from '../utils/strings'
import { scanStorageFiles, type ScanFilesOptions } from '../storage-files'
import { Check, CheckSkipped, type CheckContext } from './base'

interface StorageBucket {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
  /** Added by storage migration 0038. STANDARD | ANALYTICS | VECTOR. */
  type?: string | null
  /** Whether the storage API auto-detects AVIF for image transforms. */
  avif_autodetection?: boolean | null
  /** Added by storage migration 0018; supersedes the deprecated `owner`. */
  owner_id?: string | null
}

interface StoragePolicy {
  tablename: string
  policyname: string
  permissive: string
  roles: string[]
  cmd: string
  qual: string | null
  with_check: string | null
}

export class StorageCheck extends Check {
  readonly name = 'storage' as const

  constructor(
    private queryFn: QueryFn = pgQuery,
    private includeFiles = false,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    // Comparing a Supabase project against a plain PostgreSQL database used to
    // fail the whole layer with `relation "storage.buckets" does not exist`.
    // An errored check reports drift as *unknown*, which is a worse outcome
    // than saying plainly that one side has no storage to compare — and the
    // auth check already handles the equivalent case by skipping (issue #42).
    const [srcHasStorage, tgtHasStorage] = await Promise.all([
      this.hasStorageSchema(ctx.source.dbUrl),
      this.hasStorageSchema(ctx.target.dbUrl),
    ])
    if (!srcHasStorage || !tgtHasStorage) {
      const which = !srcHasStorage && !tgtHasStorage ? 'neither environment has'
        : !srcHasStorage ? 'the source does not have'
        : 'the target does not have'
      throw new CheckSkipped(`${which} a storage schema — not a Supabase project`)
    }

    const bucketIssues = await this.scanBuckets(ctx)
    const policyIssues = await this.scanPolicies(ctx)

    let fileIssues: DriftIssue[] = []
    if (this.includeFiles) {
      fileIssues = await this.scanFiles(ctx)
    }

    return [...bucketIssues, ...policyIssues, ...fileIssues]
  }

  private async scanBuckets(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.listBuckets(ctx.source.dbUrl),
      this.listBuckets(ctx.target.dbUrl),
    ])

    return diffBuckets(source, target, {
      apiUrl: ctx.target.apiUrl,
      accessToken: ctx.target.accessToken,
    })
  }

  private async scanPolicies(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchStoragePolicies(ctx.source.dbUrl),
      this.fetchStoragePolicies(ctx.target.dbUrl),
    ])
    return diffStoragePolicies(source, target)
  }

  private async hasStorageSchema(dbUrl: string): Promise<boolean> {
    const rows = await this.queryFn(dbUrl, STORAGE_PRESENT_SQL) as unknown as Array<{ present: boolean }>
    return rows[0]?.present === true
  }

  /**
   * Read the buckets, selecting only the columns this Supabase version actually
   * has. storage.buckets has grown over time (owner_id in 0018, type in 0038),
   * so a fixed column list either misses columns on a new instance or fails on
   * an old one. Resolving them per-connection handles both.
   */
  private async listBuckets(dbUrl: string): Promise<StorageBucket[]> {
    const present = await this.queryFn(dbUrl, BUCKET_COLUMNS_SQL) as unknown as Array<{ column_name: string }>
    const names = new Set(present.map(r => r.column_name))
    const cols = COMPARED_BUCKET_COLUMNS.filter(c => names.has(c))
    const sql = `SELECT ${cols.join(', ')} FROM storage.buckets ORDER BY name`
    return await this.queryFn(dbUrl, sql) as unknown as StorageBucket[]
  }

  private async fetchStoragePolicies(dbUrl: string): Promise<StoragePolicy[]> {
    return await this.queryFn(dbUrl, STORAGE_POLICY_SQL) as unknown as StoragePolicy[]
  }

  private async scanFiles(ctx: CheckContext): Promise<DriftIssue[]> {
    const sourceRef = ctx.source.projectRef
    const targetRef = ctx.target.projectRef
    const sourceKey = ctx.source.accessToken
    const targetKey = ctx.target.accessToken

    // File scanning requires projectRef + accessToken for both environments
    if (!sourceRef || !targetRef || !sourceKey || !targetKey) return []

    const options: ScanFilesOptions = {
      sourceRef,
      targetRef,
      sourceKey,
      targetKey,
      sourceApiUrl: ctx.source.apiUrl,
      targetApiUrl: ctx.target.apiUrl,
    }

    return await scanStorageFiles(options)
  }
}

/**
 * Bucket columns worth comparing, in select order.
 *
 * Only the first five used to be read, so a bucket switched between STANDARD,
 * ANALYTICS and VECTOR — an entirely different storage backend — compared as
 * identical and the layer reported "no drift detected".
 *
 * Deliberately excludes created_at/updated_at (timestamps differ between any
 * two environments and mean nothing) and the deprecated `owner` column, which
 * migration 0018 replaced with owner_id.
 */
const COMPARED_BUCKET_COLUMNS = [
  'id', 'name', 'public', 'file_size_limit', 'allowed_mime_types',
  'type', 'avif_autodetection', 'owner_id',
] as const

/** Which of those this particular Supabase version actually has. */
const BUCKET_COLUMNS_SQL = `
  SELECT column_name
  FROM information_schema.columns
  WHERE table_schema = 'storage' AND table_name = 'buckets'
`

/** Whether this database is a Supabase project at all. */
const STORAGE_PRESENT_SQL = `
  SELECT EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'buckets'
  ) AS present
`

/** Query RLS policies specifically on the storage schema (normally excluded from main RLS layer). */
const STORAGE_POLICY_SQL = `
  SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'storage'
  ORDER BY tablename, policyname
`

// ─── Bucket diffing ──────────────────────────────────────────────────────────

interface BucketDiffConfig {
  apiUrl?: string
  accessToken?: string
}

function bucketApiHeaders(accessToken?: string): Record<string, string> {
  if (!accessToken) return {}
  return { apikey: accessToken, Authorization: `Bearer ${accessToken}` }
}

function bucketAction(
  config: BucketDiffConfig,
  method: SyncAction['method'],
  path: string,
  label: string,
  body?: unknown,
): SyncAction {
  return {
    method,
    url: `${config.apiUrl}/storage/v1/bucket${path}`,
    headers: bucketApiHeaders(config.accessToken),
    label,
    ...(body !== undefined && { body }),
  }
}

function diffBuckets(
  source: StorageBucket[],
  target: StorageBucket[],
  config?: BucketDiffConfig,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(b => [b.id, b]))
  const targetMap = new Map(target.map(b => [b.id, b]))
  const useApi = !!config?.apiUrl

  for (const [id, b] of sourceMap) {
    if (!targetMap.has(id)) {
      const issue: DriftIssue = {
        id: `storage-missing-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Missing bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in source but not in target.`,
        sourceValue: b,
      }

      if (useApi) {
        issue.action = bucketAction(config!, 'POST', '', `Create bucket "${b.name}"`, {
          id: b.id,
          name: b.name,
          public: b.public,
          file_size_limit: b.file_size_limit,
          allowed_mime_types: b.allowed_mime_types,
        })
      } else {
        issue.sql = {
          up: `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${sqlLiteral(b.id)}, ${sqlLiteral(b.name)}, ${sqlLiteral(b.public)}, ${sqlLiteral(b.file_size_limit)}, ${sqlLiteral(b.allowed_mime_types)});`,
          down: `DELETE FROM storage.buckets WHERE id = ${sqlLiteral(b.id)};`,
        }
      }

      issues.push(issue)
    }
  }

  for (const [id, b] of targetMap) {
    if (!sourceMap.has(id)) {
      const issue: DriftIssue = {
        id: `storage-extra-${id}`,
        check: 'storage',
        severity: 'info',
        title: `Extra bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in target but not in source.`,
        targetValue: b,
      }

      if (useApi) {
        issue.action = bucketAction(config!, 'DELETE', `/${id}`, `Delete bucket "${b.name}"`)
      } else {
        issue.sql = {
          up: `DELETE FROM storage.buckets WHERE id = ${sqlLiteral(b.id)};`,
          down: `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${sqlLiteral(b.id)}, ${sqlLiteral(b.name)}, ${sqlLiteral(b.public)}, ${sqlLiteral(b.file_size_limit)}, ${sqlLiteral(b.allowed_mime_types)});`,
        }
      }

      issues.push(issue)
    }
  }

  for (const [id, sb] of sourceMap) {
    const tb = targetMap.get(id)
    if (!tb) continue

    const setClauses: string[] = []

    if (sb.public !== tb.public) {
      setClauses.push(`public = ${sqlLiteral(sb.public)}`)
      issues.push({
        id: `storage-visibility-${id}`,
        check: 'storage',
        severity: sb.public && !tb.public ? 'warning' : 'critical',
        title: `Bucket visibility mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" is ${sb.public ? 'public' : 'private'} in source but ${tb.public ? 'public' : 'private'} in target.`,
        sourceValue: { public: sb.public },
        targetValue: { public: tb.public },
      })
    }

    if (sb.file_size_limit !== tb.file_size_limit) {
      setClauses.push(`file_size_limit = ${sqlLiteral(sb.file_size_limit)}`)
      issues.push({
        id: `storage-sizelimit-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Bucket file size limit mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" file_size_limit is ${sb.file_size_limit ?? 'unlimited'} in source but ${tb.file_size_limit ?? 'unlimited'} in target.`,
        sourceValue: { file_size_limit: sb.file_size_limit },
        targetValue: { file_size_limit: tb.file_size_limit },
      })
    }

    const srcMimes = (sb.allowed_mime_types ?? []).slice().sort().join(',')
    const tgtMimes = (tb.allowed_mime_types ?? []).slice().sort().join(',')
    if (srcMimes !== tgtMimes) {
      setClauses.push(`allowed_mime_types = ${sqlLiteral(sb.allowed_mime_types)}`)
      issues.push({
        id: `storage-mimetypes-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Bucket allowed MIME types mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" allowed_mime_types differ between source and target.`,
        sourceValue: { allowed_mime_types: sb.allowed_mime_types },
        targetValue: { allowed_mime_types: tb.allowed_mime_types },
      })
    }

    // Changing a bucket's type switches its storage backend outright, so this
    // is critical rather than a tweak. Compared only when both sides report the
    // column, since it arrived in storage migration 0038.
    if (sb.type !== undefined && tb.type !== undefined && sb.type !== tb.type) {
      setClauses.push(`type = ${sqlLiteral(sb.type)}`)
      issues.push({
        id: `storage-type-${id}`,
        check: 'storage',
        severity: 'critical',
        title: `Bucket type mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" is ${sb.type} in source but ${tb.type} in target — these are different storage backends, not a setting.`,
        sourceValue: { type: sb.type },
        targetValue: { type: tb.type },
      })
    }

    if (sb.avif_autodetection !== undefined && tb.avif_autodetection !== undefined
        && sb.avif_autodetection !== tb.avif_autodetection) {
      setClauses.push(`avif_autodetection = ${sqlLiteral(sb.avif_autodetection)}`)
      issues.push({
        id: `storage-avif-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Bucket AVIF autodetection mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" avif_autodetection is ${sb.avif_autodetection} in source but ${tb.avif_autodetection} in target.`,
        sourceValue: { avif_autodetection: sb.avif_autodetection },
        targetValue: { avif_autodetection: tb.avif_autodetection },
      })
    }

    // owner_id is reported but never synced: it references a user that exists
    // in one project and not the other, so copying the value across would
    // point the bucket at an identity that does not exist there.
    if (sb.owner_id !== undefined && tb.owner_id !== undefined && sb.owner_id !== tb.owner_id) {
      issues.push({
        id: `storage-owner-${id}`,
        check: 'storage',
        severity: 'info',
        title: `Bucket owner mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" has a different owner_id in each environment. Not synced — the owner is an identity local to its own project.`,
        sourceValue: { owner_id: sb.owner_id },
        targetValue: { owner_id: tb.owner_id },
      })
    }

    // Attach sync fix to the first property-diff issue for this bucket
    if (setClauses.length > 0) {
      const firstBucketIssue = issues.find(i =>
        i.id.startsWith(`storage-visibility-${id}`) ||
        i.id.startsWith(`storage-sizelimit-${id}`) ||
        i.id.startsWith(`storage-mimetypes-${id}`) ||
        i.id.startsWith(`storage-type-${id}`) ||
        i.id.startsWith(`storage-avif-${id}`),
      )
      if (firstBucketIssue) {
        if (useApi) {
          firstBucketIssue.action = bucketAction(config!, 'PUT', `/${id}`, `Update bucket "${sb.name}"`, {
            public: sb.public,
            file_size_limit: sb.file_size_limit,
            allowed_mime_types: sb.allowed_mime_types,
          })
        } else {
          const revertClauses: string[] = []
          if (sb.public !== tb.public) revertClauses.push(`public = ${sqlLiteral(tb.public)}`)
          if (sb.file_size_limit !== tb.file_size_limit) revertClauses.push(`file_size_limit = ${sqlLiteral(tb.file_size_limit)}`)
          if (srcMimes !== tgtMimes) revertClauses.push(`allowed_mime_types = ${sqlLiteral(tb.allowed_mime_types)}`)

          firstBucketIssue.sql = {
            up: `UPDATE storage.buckets SET ${setClauses.join(', ')} WHERE id = ${sqlLiteral(id)};`,
            down: `UPDATE storage.buckets SET ${revertClauses.join(', ')} WHERE id = ${sqlLiteral(id)};`,
          }
        }
      }
    }
  }

  return issues
}

// ─── Storage policy diffing ──────────────────────────────────────────────────

function storagePolicyKey(p: StoragePolicy): string {
  return `${p.tablename}.${p.policyname}`
}

function storagePoliciesEqual(a: StoragePolicy, b: StoragePolicy): boolean {
  return (
    a.permissive === b.permissive &&
    a.cmd === b.cmd &&
    JSON.stringify(normalizeRoles(a.roles)) === JSON.stringify(normalizeRoles(b.roles)) &&
    (a.qual ?? '') === (b.qual ?? '') &&
    (a.with_check ?? '') === (b.with_check ?? '')
  )
}

// normalizeRoles imported from utils/strings

function generateStorageCreatePolicySql(p: StoragePolicy): string {
  const roles = normalizeRoles(p.roles).join(', ')
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

function generateStorageDropPolicySql(p: StoragePolicy): string {
  return `DROP POLICY IF EXISTS "${p.policyname}" ON "storage"."${p.tablename}";`
}

function diffStoragePolicies(source: StoragePolicy[], target: StoragePolicy[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(p => [storagePolicyKey(p), p]))
  const targetMap = new Map(target.map(p => [storagePolicyKey(p), p]))

  for (const [key, sp] of sourceMap) {
    if (!targetMap.has(key)) {
      issues.push({
        id: `storage-policy-missing-${key}`,
        check: 'storage',
        severity: 'critical',
        title: `Missing storage policy: ${sp.policyname} on ${sp.tablename}`,
        description: `Storage RLS policy "${sp.policyname}" on storage.${sp.tablename} exists in source but not in target.`,
        sourceValue: sp,
        sql: {
          up: generateStorageCreatePolicySql(sp),
          down: generateStorageDropPolicySql(sp),
        },
      })
    }
  }

  for (const [key, tp] of targetMap) {
    if (!sourceMap.has(key)) {
      issues.push({
        id: `storage-policy-extra-${key}`,
        check: 'storage',
        severity: 'info',
        title: `Extra storage policy: ${tp.policyname} on ${tp.tablename}`,
        description: `Storage RLS policy "${tp.policyname}" on storage.${tp.tablename} exists in target but not in source.`,
        targetValue: tp,
        sql: {
          up: generateStorageDropPolicySql(tp),
          down: generateStorageCreatePolicySql(tp),
        },
      })
    }
  }

  for (const [key, sp] of sourceMap) {
    const tp = targetMap.get(key)
    if (!tp || storagePoliciesEqual(sp, tp)) continue
    issues.push({
      id: `storage-policy-changed-${key}`,
      check: 'storage',
      severity: 'critical',
      title: `Storage policy changed: ${sp.policyname} on ${sp.tablename}`,
      description: `Storage RLS policy "${sp.policyname}" on storage.${sp.tablename} differs between source and target.`,
      sourceValue: sp,
      targetValue: tp,
      sql: {
        up: [generateStorageDropPolicySql(sp), generateStorageCreatePolicySql(sp)].join('\n'),
        down: [generateStorageDropPolicySql(tp), generateStorageCreatePolicySql(tp)].join('\n'),
      },
    })
  }

  return issues
}
