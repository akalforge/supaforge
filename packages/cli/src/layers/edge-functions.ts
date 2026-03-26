import type { DriftIssue, SyncAction } from '../types/drift'
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

/** Supabase Management API base URL */
const MGMT_API = 'https://api.supabase.com/v1/projects'

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

    return diffFunctions(source, target, targetRef, targetKey)
  }

  private async listFunctions(projectRef: string, apiKey: string): Promise<EdgeFunction[]> {
    const url = `${MGMT_API}/${encodeURIComponent(projectRef)}/functions`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${apiKey}` },
    })
    if (!res.ok) throw new Error(`Failed to list functions for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<EdgeFunction[]>
  }
}

function makeDeleteAction(slug: string, targetRef: string, targetKey: string): SyncAction {
  return {
    method: 'DELETE',
    url: `${MGMT_API}/${encodeURIComponent(targetRef)}/functions/${encodeURIComponent(slug)}`,
    headers: { Authorization: `Bearer ${targetKey}` },
    label: `Delete Edge Function "${slug}" from target`,
  }
}

function diffFunctions(
  source: EdgeFunction[],
  target: EdgeFunction[],
  targetRef: string,
  targetKey: string,
): DriftIssue[] {
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
        description: `Function "${f.name}" (${slug}) exists in source but not in target. Deploy it via "supabase functions deploy ${slug}" against the target project.`,
        sourceValue: f,
        // Cannot auto-deploy: source code is not available via the Management API.
        // User must deploy from their local supabase/functions/ directory.
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
        action: makeDeleteAction(slug, targetRef, targetKey),
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
        description: `Function "${slug}" is at version ${sf.version} in source but version ${tf.version} in target. Redeploy via "supabase functions deploy ${slug}" against the target project.`,
        sourceValue: sf,
        targetValue: tf,
        // Cannot auto-deploy: source code is not available via the Management API.
      })
    }
  }

  return issues
}
