import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import type { DriftIssue } from '../types/drift'
import { Layer, type LayerContext } from './base'

interface WebhookEntry {
  id: number
  hook_table_id: number
  hook_name: string
  created_at: string
  request_id: number | null
}

export class WebhooksLayer extends Layer {
  readonly name = 'webhooks' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: LayerContext): Promise<DriftIssue[]> {
    const [sourceHooks, targetHooks, sourceNet, targetNet] = await Promise.all([
      this.fetchHooks(ctx.source.dbUrl),
      this.fetchHooks(ctx.target.dbUrl),
      this.checkPgNet(ctx.source.dbUrl),
      this.checkPgNet(ctx.target.dbUrl),
    ])

    const issues: DriftIssue[] = []

    // Check pg_net extension status
    if (sourceNet && !targetNet) {
      issues.push({
        id: 'webhooks-pgnet-missing',
        layer: 'webhooks',
        severity: 'critical',
        title: 'pg_net extension missing in target',
        description: 'The pg_net extension is enabled in source but not in target. Database webhooks will silently fail.',
        sql: {
          up: 'CREATE EXTENSION IF NOT EXISTS pg_net;',
          down: 'DROP EXTENSION IF EXISTS pg_net;',
        },
      })
    }

    issues.push(...diffHooks(sourceHooks, targetHooks))

    return issues
  }

  private async fetchHooks(dbUrl: string): Promise<WebhookEntry[]> {
    try {
      return await this.queryFn(dbUrl, HOOKS_SQL) as unknown as WebhookEntry[]
    } catch {
      return []
    }
  }

  private async checkPgNet(dbUrl: string): Promise<boolean> {
    try {
      const rows = await this.queryFn(dbUrl, PG_NET_CHECK_SQL)
      return rows.length > 0
    } catch {
      return false
    }
  }
}

const HOOKS_SQL = `
  SELECT id, hook_table_id, hook_name, created_at, request_id
  FROM supabase_functions.hooks
  ORDER BY hook_name, id
`

const PG_NET_CHECK_SQL = `
  SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
`

function diffHooks(source: WebhookEntry[], target: WebhookEntry[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(h => [h.hook_name, h]))
  const targetMap = new Map(target.map(h => [h.hook_name, h]))

  for (const [name, h] of sourceMap) {
    if (!targetMap.has(name)) {
      issues.push({
        id: `webhooks-missing-${name}`,
        layer: 'webhooks',
        severity: 'warning',
        title: `Missing webhook: ${name}`,
        description: `Webhook "${name}" exists in source but not in target.`,
        sourceValue: h,
      })
    }
  }

  for (const [name, h] of targetMap) {
    if (!sourceMap.has(name)) {
      issues.push({
        id: `webhooks-extra-${name}`,
        layer: 'webhooks',
        severity: 'info',
        title: `Extra webhook: ${name}`,
        description: `Webhook "${name}" exists in target but not in source.`,
        targetValue: h,
      })
    }
  }

  return issues
}
