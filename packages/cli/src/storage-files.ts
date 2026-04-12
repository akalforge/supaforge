import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import type { DriftIssue } from './types/drift'

// ─── Constants ───────────────────────────────────────────────────────────────

const LIST_LIMIT = 1000
const JSON_MIME_TYPES = ['application/json', 'text/json']

// ─── Types ───────────────────────────────────────────────────────────────────

export interface StorageFileInfo {
  bucket: string
  path: string
  /** File name (leaf). */
  name: string
  size: number
  /** ISO timestamp string or null. */
  createdAt: string | null
  updatedAt: string | null
  /** MIME type from metadata. */
  mimeType: string | null
  /** MD5 hex digest of file content (only populated for JSON files). */
  checksum: string | null
}

export interface FileDiffEntry {
  bucket: string
  path: string
  type: 'missing' | 'extra' | 'changed'
  details: string
  sourceFile?: StorageFileInfo
  targetFile?: StorageFileInfo
}

/** Minimal interface for Supabase client creation — allows DI for testing. */
export type CreateClientFn = (url: string, key: string) => SupabaseClient

// ─── Supabase Client Factory ─────────────────────────────────────────────────

/**
 * Build a Supabase URL from a project ref.
 * Supports custom apiUrl override for self-hosted instances.
 */
function buildSupabaseUrl(projectRef: string, apiUrl?: string): string {
  if (apiUrl) return apiUrl
  return `https://${projectRef}.supabase.co`
}

// ─── Recursive File Listing ──────────────────────────────────────────────────

/**
 * Recursively list all files in a Supabase storage bucket.
 * Uses the Supabase SDK's `storage.from(bucket).list()`.
 */
async function listBucketFiles(
  client: SupabaseClient,
  bucket: string,
  folder = '',
): Promise<Array<{ name: string; path: string; metadata: Record<string, unknown> | null }>> {
  const results: Array<{ name: string; path: string; metadata: Record<string, unknown> | null }> = []

  const { data, error } = await client.storage.from(bucket).list(folder, {
    limit: LIST_LIMIT,
    sortBy: { column: 'name', order: 'asc' },
  })

  if (error || !data) return results

  for (const item of data) {
    const itemPath = folder ? `${folder}/${item.name}` : item.name

    // null id = folder in Supabase storage
    if (item.id === null) {
      const children = await listBucketFiles(client, bucket, itemPath)
      results.push(...children)
    } else {
      results.push({
        name: item.name,
        path: itemPath,
        metadata: (item as unknown as Record<string, unknown>).metadata as Record<string, unknown> | null,
      })
    }
  }

  return results
}

/**
 * Resolve file metadata from Supabase listing entry.
 */
function toFileInfo(
  bucket: string,
  entry: { name: string; path: string; metadata: Record<string, unknown> | null },
): StorageFileInfo {
  const meta = entry.metadata ?? {}
  return {
    bucket,
    path: entry.path,
    name: entry.name,
    size: typeof meta.size === 'number' ? meta.size : 0,
    createdAt: typeof meta.lastModified === 'string' ? meta.lastModified : null,
    updatedAt: typeof meta.lastModified === 'string' ? meta.lastModified : null,
    mimeType: typeof meta.mimetype === 'string' ? meta.mimetype : null,
    checksum: null, // populated later for JSON files
  }
}

/**
 * Compute MD5 checksum of file content.
 */
function md5(content: string | Buffer): string {
  return createHash('md5').update(content).digest('hex')
}

/**
 * Determine if a file is JSON based on MIME type or file extension.
 */
function isJsonFile(file: StorageFileInfo): boolean {
  if (file.mimeType && JSON_MIME_TYPES.includes(file.mimeType)) return true
  return file.name.endsWith('.json')
}

// ─── Full File Inventory ─────────────────────────────────────────────────────

/**
 * Inventory all files across all buckets for one environment.
 * Optionally computes MD5 checksums for JSON files.
 */
export async function inventoryFiles(
  client: SupabaseClient,
  buckets: string[],
  computeChecksums: boolean,
): Promise<StorageFileInfo[]> {
  const allFiles: StorageFileInfo[] = []

  for (const bucket of buckets) {
    const entries = await listBucketFiles(client, bucket)
    const files = entries.map(e => toFileInfo(bucket, e))

    if (computeChecksums) {
      for (const file of files) {
        if (isJsonFile(file)) {
          try {
            const { data, error } = await client.storage
              .from(bucket)
              .download(file.path)
            if (!error && data) {
              const text = await data.text()
              file.checksum = md5(text)
            }
          } catch {
            // Can't download — leave checksum null
          }
        }
      }
    }

    allFiles.push(...files)
  }

  return allFiles
}

// ─── Diff Logic ──────────────────────────────────────────────────────────────

/** Unique key for a file: bucket/path */
function fileKey(file: StorageFileInfo): string {
  return `${file.bucket}/${file.path}`
}

/**
 * Compare file inventories between source and target environments.
 *
 * For JSON files: compare by checksum (content-level diff).
 * For other files: compare by size + last-modified metadata.
 */
export function diffFileInventories(
  sourceFiles: StorageFileInfo[],
  targetFiles: StorageFileInfo[],
): FileDiffEntry[] {
  const diffs: FileDiffEntry[] = []
  const sourceMap = new Map(sourceFiles.map(f => [fileKey(f), f]))
  const targetMap = new Map(targetFiles.map(f => [fileKey(f), f]))

  // Files in source but not target
  for (const [key, sf] of sourceMap) {
    if (!targetMap.has(key)) {
      diffs.push({
        bucket: sf.bucket,
        path: sf.path,
        type: 'missing',
        details: `File "${sf.path}" exists in source bucket "${sf.bucket}" but not in target.`,
        sourceFile: sf,
      })
    }
  }

  // Files in target but not source
  for (const [key, tf] of targetMap) {
    if (!sourceMap.has(key)) {
      diffs.push({
        bucket: tf.bucket,
        path: tf.path,
        type: 'extra',
        details: `File "${tf.path}" exists in target bucket "${tf.bucket}" but not in source.`,
        targetFile: tf,
      })
    }
  }

  // Files in both — compare
  for (const [key, sf] of sourceMap) {
    const tf = targetMap.get(key)
    if (!tf) continue

    const changes: string[] = []

    // JSON files: compare by checksum
    if (sf.checksum && tf.checksum) {
      if (sf.checksum !== tf.checksum) {
        changes.push(`content differs (source md5: ${sf.checksum.slice(0, 12)}…, target md5: ${tf.checksum.slice(0, 12)}…)`)
      }
    } else {
      // Non-JSON or checksums unavailable: compare metadata
      if (sf.size !== tf.size) {
        changes.push(`size differs (source: ${sf.size} bytes, target: ${tf.size} bytes)`)
      }
      if (sf.updatedAt && tf.updatedAt && sf.updatedAt !== tf.updatedAt) {
        changes.push(`last modified differs (source: ${sf.updatedAt}, target: ${tf.updatedAt})`)
      }
    }

    if (changes.length > 0) {
      diffs.push({
        bucket: sf.bucket,
        path: sf.path,
        type: 'changed',
        details: `File "${sf.path}" in bucket "${sf.bucket}": ${changes.join('; ')}.`,
        sourceFile: sf,
        targetFile: tf,
      })
    }
  }

  return diffs
}

// ─── Drift Issue Conversion ──────────────────────────────────────────────────

/**
 * Convert file diff entries into standard DriftIssues for the scan output.
 */
export function fileDiffsToIssues(diffs: FileDiffEntry[]): DriftIssue[] {
  return diffs.map(d => ({
    id: `storage-file-${d.type}-${d.bucket}-${d.path.replace(/[^a-zA-Z0-9]/g, '-')}`,
    check: 'storage' as const,
    severity: d.type === 'missing' ? 'warning' : d.type === 'extra' ? 'info' : 'warning',
    title: d.type === 'missing'
      ? `Missing file: ${d.bucket}/${d.path}`
      : d.type === 'extra'
        ? `Extra file: ${d.bucket}/${d.path}`
        : `Changed file: ${d.bucket}/${d.path}`,
    description: d.details,
    sourceValue: d.sourceFile,
    targetValue: d.targetFile,
  }))
}

// ─── Main Entry Point ────────────────────────────────────────────────────────

export interface ScanFilesOptions {
  /** Source project ref. */
  sourceRef: string
  /** Target project ref. */
  targetRef: string
  /** Source service role key or access token with storage access. */
  sourceKey: string
  /** Target service role key or access token with storage access. */
  targetKey: string
  /** Override URL for self-hosted source. */
  sourceApiUrl?: string
  /** Override URL for self-hosted target. */
  targetApiUrl?: string
  /** Only scan these buckets (default: all shared buckets). */
  buckets?: string[]
  /** Factory for Supabase client (DI seam for tests). */
  createClientFn?: CreateClientFn
}

/**
 * Scan file-level drift across Supabase storage buckets.
 *
 * Lists all files in all (or specified) buckets for both environments,
 * computes MD5 checksums for JSON files, and diffs the inventories.
 */
export async function scanStorageFiles(options: ScanFilesOptions): Promise<DriftIssue[]> {
  const factory = options.createClientFn ?? createClient

  const sourceClient = factory(
    buildSupabaseUrl(options.sourceRef, options.sourceApiUrl),
    options.sourceKey,
  )
  const targetClient = factory(
    buildSupabaseUrl(options.targetRef, options.targetApiUrl),
    options.targetKey,
  )

  // Discover shared buckets
  let buckets: string[]
  if (options.buckets?.length) {
    buckets = options.buckets
  } else {
    const [{ data: sb }, { data: tb }] = await Promise.all([
      sourceClient.storage.listBuckets(),
      targetClient.storage.listBuckets(),
    ])
    const sourceNames = new Set((sb ?? []).map((b: { name: string }) => b.name))
    const targetNames = new Set((tb ?? []).map((b: { name: string }) => b.name))
    // Only diff buckets present in both environments
    buckets = [...sourceNames].filter(n => targetNames.has(n))
  }

  if (buckets.length === 0) return []

  const [sourceFiles, targetFiles] = await Promise.all([
    inventoryFiles(sourceClient, buckets, true),
    inventoryFiles(targetClient, buckets, true),
  ])

  const diffs = diffFileInventories(sourceFiles, targetFiles)
  return fileDiffsToIssues(diffs)
}
