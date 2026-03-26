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
  /** The associated trigger function body (extracted from pg_proc). */
  function_body: string | null
  /** The events the trigger fires on (INSERT, UPDATE, DELETE). */
  events: string | null
  /** The table the trigger is attached to (schema.table). */
  trigger_table: string | null
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

/**
 * Extended query joining hooks with trigger metadata.
 * Supabase database webhooks are backed by triggers — we extract the
 * trigger function body and event types so we can generate sync SQL.
 */
const HOOKS_SQL = `
  SELECT
    h.id,
    h.hook_table_id,
    h.hook_name,
    h.created_at,
    h.request_id,
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
      // Build sync SQL if we have enough metadata
      const sql = h.function_body && h.events && h.trigger_table
        ? {
            up: [
              `-- Recreate trigger function`,
              h.function_body + ';',
              '',
              `-- Recreate trigger`,
              `CREATE TRIGGER "${h.hook_name}"`,
              `  AFTER ${h.events}`,
              `  ON ${h.trigger_table}`,
              `  FOR EACH ROW`,
              `  EXECUTE FUNCTION supabase_functions.http_request();`,
            ].join('\n'),
            down: `DROP TRIGGER IF EXISTS "${h.hook_name}" ON ${h.trigger_table};`,
          }
        : undefined

      issues.push({
        id: `webhooks-missing-${name}`,
        layer: 'webhooks',
        severity: 'warning',
        title: `Missing webhook: ${name}`,
        description: h.trigger_table
          ? `Webhook "${name}" on ${h.trigger_table} (${h.events}) exists in source but not in target.`
          : `Webhook "${name}" exists in source but not in target.`,
        sourceValue: h,
        sql,
      })
    }
  }

  for (const [name, h] of targetMap) {
    if (!sourceMap.has(name)) {
      const sql = h.trigger_table
        ? {
            up: `DROP TRIGGER IF EXISTS "${h.hook_name}" ON ${h.trigger_table};`,
            down: '', // Cannot reconstruct — info-level issue anyway
          }
        : undefined

      issues.push({
        id: `webhooks-extra-${name}`,
        layer: 'webhooks',
        severity: 'info',
        title: `Extra webhook: ${name}`,
        description: h.trigger_table
          ? `Webhook "${name}" on ${h.trigger_table} exists in target but not in source.`
          : `Webhook "${name}" exists in target but not in source.`,
        targetValue: h,
        sql,
      })
    }
  }

  return issues
}
