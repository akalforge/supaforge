import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

interface EdgeFunction {
  slug: string
  name: string
  version: number
  status: string
  created_at: string
  updated_at: string
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class EdgeFunctionsLayer extends Layer {
  readonly name = 'edge-functions' as const

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
      this.listFunctions(sourceRef, sourceKey),
      this.listFunctions(targetRef, targetKey),
    ])

    return diffFunctions(source, target)
  }

  private async listFunctions(projectRef: string, apiKey: string): Promise<EdgeFunction[]> {
    const url = `https://api.supabase.com/v1/projects/${encodeURIComponent(projectRef)}/functions`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to list functions for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<EdgeFunction[]>
  }
}

function diffFunctions(source: EdgeFunction[], target: EdgeFunction[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(f => [f.slug, f]))
  const targetMap = new Map(target.map(f => [f.slug, f]))

  for (const [slug, f] of sourceMap) {
    if (!targetMap.has(slug)) {
      issues.push({
        id: `edge-fn-missing-${slug}`,
        layer: 'edge-functions',
        severity: 'warning',
        title: `Missing Edge Function: ${slug}`,
        description: `Function "${f.name}" (${slug}) exists in source but not in target.`,
        sourceValue: f,
      })
    }
  }

  for (const [slug, f] of targetMap) {
    if (!sourceMap.has(slug)) {
      issues.push({
        id: `edge-fn-extra-${slug}`,
        layer: 'edge-functions',
        severity: 'info',
        title: `Extra Edge Function: ${slug}`,
        description: `Function "${f.name}" (${slug}) exists in target but not in source.`,
        targetValue: f,
      })
    }
  }

  for (const [slug, sf] of sourceMap) {
    const tf = targetMap.get(slug)
    if (tf && sf.version !== tf.version) {
      issues.push({
        id: `edge-fn-version-${slug}`,
        layer: 'edge-functions',
        severity: 'warning',
        title: `Version mismatch: ${slug}`,
        description: `Function "${slug}" is at version ${sf.version} in source but version ${tf.version} in target.`,
        sourceValue: sf,
        targetValue: tf,
      })
    }
  }

  return issues
}
