import type { DriftIssue, SyncAction } from '../types/drift'
import { Check, type CheckContext } from './base'
import { SUPABASE_MGMT_API } from '../constants'

interface EdgeFunction {
  slug: string
  name: string
  version: number
  status: string
  created_at: string
  updated_at: string
}

export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>

export class EdgeFunctionsCheck extends Check {
  readonly name = 'edge-functions' as const

  constructor(private fetchFn: FetchFn = globalThis.fetch.bind(globalThis)) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
    const sourceRef = ctx.source.projectRef
    const targetRef = ctx.target.projectRef
    const sourceKey = ctx.source.accessToken
    const targetKey = ctx.target.accessToken

    if (!sourceRef || !targetRef || !sourceKey || !targetKey) {
      return []
    }

    const [source, target] = await Promise.all([
      this.listFunctions(sourceRef, sourceKey),
      this.listFunctions(targetRef, targetKey),
    ])

    return diffFunctions(source, target, targetRef, targetKey)
  }

  private async listFunctions(projectRef: string, accessToken: string): Promise<EdgeFunction[]> {
    const url = `${SUPABASE_MGMT_API}/${encodeURIComponent(projectRef)}/functions`
    const res = await this.fetchFn(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) throw new Error(`Failed to list functions for ${projectRef}: ${res.statusText}`)
    return res.json() as Promise<EdgeFunction[]>
  }
}

function makeDeleteAction(slug: string, targetRef: string, targetKey: string): SyncAction {
  return {
    method: 'DELETE',
    url: `${SUPABASE_MGMT_API}/${encodeURIComponent(targetRef)}/functions/${encodeURIComponent(slug)}`,
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
        check: 'edge-functions',
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
        check: 'edge-functions',
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
        check: 'edge-functions',
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
