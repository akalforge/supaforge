import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
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

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class StorageCheck extends Check {
  readonly name = 'storage' as const

  constructor(
    private fetchFn: FetchFn = globalThis.fetch.bind(globalThis),
    private queryFn: QueryFn = pgQuery,
  ) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const bucketIssues = await this.scanBuckets(ctx)
    const policyIssues = await this.scanPolicies(ctx)
    return [...bucketIssues, ...policyIssues]
  }

  private async scanBuckets(ctx: CheckContext): Promise<DriftIssue[]> {
    const { projectRef: sourceRef, apiKey: sourceKey, apiUrl: sourceApiUrl } = ctx.source
    const { projectRef: targetRef, apiKey: targetKey, apiUrl: targetApiUrl } = ctx.target

    if ((!sourceRef && !sourceApiUrl) || (!targetRef && !targetApiUrl) || !sourceKey || !targetKey) {
      return []
    }

    const [source, target] = await Promise.all([
      this.listBuckets(sourceRef, sourceKey, sourceApiUrl),
      this.listBuckets(targetRef, targetKey, targetApiUrl),
    ])

    return diffBuckets(source, target, targetRef, targetKey, targetApiUrl)
  }

  private async scanPolicies(ctx: CheckContext): Promise<DriftIssue[]> {
    const [source, target] = await Promise.all([
      this.fetchStoragePolicies(ctx.source.dbUrl),
      this.fetchStoragePolicies(ctx.target.dbUrl),
    ])
    return diffStoragePolicies(source, target)
  }

  private async listBuckets(projectRef: string | undefined, apiKey: string, apiUrl?: string): Promise<StorageBucket[]> {
    const base = apiUrl
      ? `${apiUrl}/storage/v1`
      : `https://${encodeURIComponent(projectRef!)}.supabase.co/storage/v1`
    const url = `${base}/bucket`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}`, apikey: apiKey },
    })
    if (!res.ok) throw new Error(`Failed to list buckets for ${projectRef ?? apiUrl}: ${res.statusText}`)
    return res.json() as Promise<StorageBucket[]>
  }

  private async fetchStoragePolicies(dbUrl: string): Promise<StoragePolicy[]> {
    return await this.queryFn(dbUrl, STORAGE_POLICY_SQL) as unknown as StoragePolicy[]
  }
}

/** Query RLS policies specifically on the storage schema (normally excluded from main RLS layer). */
const STORAGE_POLICY_SQL = `
  SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
  FROM pg_policies
  WHERE schemaname = 'storage'
  ORDER BY tablename, policyname
`

// ─── Bucket diffing ──────────────────────────────────────────────────────────

function storageBaseUrl(targetRef?: string, apiUrl?: string): string {
  if (apiUrl) return `${apiUrl}/storage/v1`
  return `https://${encodeURIComponent(targetRef!)}.supabase.co/storage/v1`
}

function diffBuckets(
  source: StorageBucket[],
  target: StorageBucket[],
  targetRef?: string,
  targetKey?: string,
  targetApiUrl?: string,
): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(b => [b.id, b]))
  const targetMap = new Map(target.map(b => [b.id, b]))
  const canSync = !!(targetRef || targetApiUrl) && !!targetKey
  const baseUrl = canSync ? storageBaseUrl(targetRef, targetApiUrl) : ''

  for (const [id, b] of sourceMap) {
    if (!targetMap.has(id)) {
      issues.push({
        id: `storage-missing-${id}`,
        check: 'storage',
        severity: 'warning',
        title: `Missing bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in source but not in target.`,
        sourceValue: b,
        action: canSync ? {
          method: 'POST',
          url: `${baseUrl}/bucket`,
          headers: { Authorization: `Bearer ${targetKey}`, apikey: targetKey! },
          body: {
            id: b.id,
            name: b.name,
            public: b.public,
            file_size_limit: b.file_size_limit,
            allowed_mime_types: b.allowed_mime_types,
          },
          label: `Create bucket "${b.name}" in target`,
        } : undefined,
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
        action: canSync ? {
          method: 'DELETE',
          url: `${baseUrl}/bucket/${encodeURIComponent(b.id)}`,
          headers: { Authorization: `Bearer ${targetKey}`, apikey: targetKey! },
          body: {},
          label: `Delete bucket "${b.name}" from target`,
        } : undefined,
      })
    }
  }

  for (const [id, sb] of sourceMap) {
    const tb = targetMap.get(id)
    if (!tb) continue

    // Collect all property diffs for a single update action
    const diffs: string[] = []
    const updateBody: Record<string, unknown> = {}

    if (sb.public !== tb.public) {
      diffs.push(`visibility (${sb.public ? 'public' : 'private'} → ${tb.public ? 'public' : 'private'})`)
      updateBody.public = sb.public
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
      diffs.push(`file_size_limit`)
      updateBody.file_size_limit = sb.file_size_limit
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
      diffs.push(`allowed_mime_types`)
      updateBody.allowed_mime_types = sb.allowed_mime_types
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

    // Attach update action to the first property-diff issue for this bucket
    if (diffs.length > 0 && canSync) {
      const action = {
        method: 'PUT' as const,
        url: `${baseUrl}/bucket/${encodeURIComponent(id)}`,
        headers: { Authorization: `Bearer ${targetKey}`, apikey: targetKey! },
        body: updateBody,
        label: `Update bucket "${sb.name}" in target (${diffs.join(', ')})`,
      }
      // Find the first issue for this bucket and attach action
      const firstBucketIssue = issues.find(i =>
        i.id.startsWith(`storage-visibility-${id}`) ||
        i.id.startsWith(`storage-sizelimit-${id}`) ||
        i.id.startsWith(`storage-mimetypes-${id}`),
      )
      if (firstBucketIssue) firstBucketIssue.action = action
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

function normalizeRoles(roles: string[] | string): string[] {
  const arr = Array.isArray(roles) ? roles : [roles]
  return arr
    .map(r => r.replace(/^\{|\}$/g, ''))
    .flatMap(r => r.split(','))
    .map(r => r.trim())
    .filter(Boolean)
    .sort()
}

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
