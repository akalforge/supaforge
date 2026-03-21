import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

interface StorageBucket {
  id: string
  name: string
  public: boolean
  file_size_limit: number | null
  allowed_mime_types: string[] | null
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class StorageLayer extends Layer {
  readonly name = 'storage' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const { projectRef: sourceRef, apiKey: sourceKey } = ctx.source
    const { projectRef: targetRef, apiKey: targetKey } = ctx.target

    if (!sourceRef || !targetRef || !sourceKey || !targetKey) {
      return []
    }

    const [source, target] = await Promise.all([
      this.listBuckets(sourceRef, sourceKey),
      this.listBuckets(targetRef, targetKey),
    ])

    return diffBuckets(source, target)
  }

  private async listBuckets(projectRef: string, apiKey: string): Promise<StorageBucket[]> {
    const url = `https://${encodeURIComponent(projectRef)}.supabase.co/storage/v1/bucket`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}`, apikey: apiKey },
    })
    if (!res.ok) throw new Error(`Failed to list buckets for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<StorageBucket[]>
  }
}

function diffBuckets(source: StorageBucket[], target: StorageBucket[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(b => [b.id, b]))
  const targetMap = new Map(target.map(b => [b.id, b]))

  for (const [id, b] of sourceMap) {
    if (!targetMap.has(id)) {
      issues.push({
        id: `storage-missing-${id}`,
        layer: 'storage',
        severity: 'warning',
        title: `Missing bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in source but not in target.`,
        sourceValue: b,
      })
    }
  }

  for (const [id, b] of targetMap) {
    if (!sourceMap.has(id)) {
      issues.push({
        id: `storage-extra-${id}`,
        layer: 'storage',
        severity: 'info',
        title: `Extra bucket: ${b.name}`,
        description: `Bucket "${b.name}" exists in target but not in source.`,
        targetValue: b,
      })
    }
  }

  for (const [id, sb] of sourceMap) {
    const tb = targetMap.get(id)
    if (!tb) continue
    if (sb.public !== tb.public) {
      issues.push({
        id: `storage-visibility-${id}`,
        layer: 'storage',
        severity: sb.public && !tb.public ? 'warning' : 'critical',
        title: `Bucket visibility mismatch: ${sb.name}`,
        description: `Bucket "${sb.name}" is ${sb.public ? 'public' : 'private'} in source but ${tb.public ? 'public' : 'private'} in target.`,
        sourceValue: { public: sb.public },
        targetValue: { public: tb.public },
      })
    }
  }

  return issues
}
