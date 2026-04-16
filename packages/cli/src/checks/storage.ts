import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { sqlLiteral } from '../utils/sql'
import { normalizeRoles } from '../utils/strings'
import { scanStorageFiles, type ScanFilesOptions } from '../storage-files'
import { Check, type CheckContext } from './base'

interface StorageBucket {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
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

    return diffBuckets(source, target)
  }

  private async scanPolicies(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchStoragePolicies(ctx.source.dbUrl),
      this.fetchStoragePolicies(ctx.target.dbUrl),
    ])
    return diffStoragePolicies(source, target)
  }

  private async listBuckets(dbUrl: string): Promise<StorageBucket[]> {
    return await this.queryFn(dbUrl, STORAGE_BUCKET_SQL) as unknown as StorageBucket[]
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

/** Query storage buckets directly from PostgreSQL. */
const STORAGE_BUCKET_SQL = `
  SELECT id, name, public, file_size_limit, allowed_mime_types
  FROM storage.buckets
  ORDER BY name
`

/** Query RLS policies specifically on the storage schema (normally excluded from main RLS layer). */
const STORAGE_POLICY_SQL = `
  SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'storage'
  ORDER BY tablename, policyname
`

// ─── Bucket diffing ──────────────────────────────────────────────────────────


function diffBuckets(
  source: StorageBucket[],
  target: StorageBucket[],
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(b => [b.id, b]))
  const targetMap = new Map(target.map(b => [b.id, b]))

  for (const [id, b] of sourceMap) {
    if (!targetMap.has(id)) {
      issues.push({
        id: `storage-missing-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Missing bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in source but not in target.`,
        sourceValue: b,
        sql: {
          up: `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${sqlLiteral(b.id)}, ${sqlLiteral(b.name)}, ${sqlLiteral(b.public)}, ${sqlLiteral(b.file_size_limit)}, ${sqlLiteral(b.allowed_mime_types)});`,
          down: `DELETE FROM storage.buckets WHERE id = ${sqlLiteral(b.id)};`,
        },
      })
    }
  }

  for (const [id, b] of targetMap) {
    if (!sourceMap.has(id)) {
      issues.push({
        id: `storage-extra-${id}`,
        check: 'storage',
        severity: 'info',
        title: `Extra bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in target but not in source.`,
        targetValue: b,
        sql: {
          up: `DELETE FROM storage.buckets WHERE id = ${sqlLiteral(b.id)};`,
          down: `INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types) VALUES (${sqlLiteral(b.id)}, ${sqlLiteral(b.name)}, ${sqlLiteral(b.public)}, ${sqlLiteral(b.file_size_limit)}, ${sqlLiteral(b.allowed_mime_types)});`,
        },
      })
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

    // Attach SQL update to the first property-diff issue for this bucket
    if (setClauses.length > 0) {
      const revertClauses: string[] = []
      if (sb.public !== tb.public) revertClauses.push(`public = ${sqlLiteral(tb.public)}`)
      if (sb.file_size_limit !== tb.file_size_limit) revertClauses.push(`file_size_limit = ${sqlLiteral(tb.file_size_limit)}`)
      if (srcMimes !== tgtMimes) revertClauses.push(`allowed_mime_types = ${sqlLiteral(tb.allowed_mime_types)}`)

      const sql = {
        up: `UPDATE storage.buckets SET ${setClauses.join(', ')} WHERE id = ${sqlLiteral(id)};`,
        down: `UPDATE storage.buckets SET ${revertClauses.join(', ')} WHERE id = ${sqlLiteral(id)};`,
      }
      const firstBucketIssue = issues.find(i =>
        i.id.startsWith(`storage-visibility-${id}`) ||
        i.id.startsWith(`storage-sizelimit-${id}`) ||
        i.id.startsWith(`storage-mimetypes-${id}`),
      )
      if (firstBucketIssue) firstBucketIssue.sql = sql
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
