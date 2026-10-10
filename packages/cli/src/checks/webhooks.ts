import type { QueryFn } from '../db'
import { pgQuery } from '../db'
import { quoteName } from '../utils/sql'
import type { DriftIssue } from '../types/drift'
import { Check, readOrAbsent, type CheckContext } from './base'

/**
 * A database webhook, as the catalog holds it.
 *
 * Read from pg_trigger, not from `supabase_functions.hooks`. That table is the
 * log of webhook *invocations*, and reading it got every question wrong
 * (issue #77): a webhook that had never fired had no rows and was invisible; a
 * deleted one still had rows and was reported as missing from the target; the
 * URL, method, headers, params and timeout live in the trigger's arguments,
 * which the log does not carry, so a generated fix recreated the trigger with
 * none of them and every insert on the target then failed with
 * `url argument is missing`; two webhooks sharing a trigger name on different
 * tables collapsed into one, because entries were keyed by name alone; and the
 * cost grew with the log rather than with the number of webhooks — 10,000 log
 * rows returned 21.9 MB for five webhooks, each row carrying its own copy of
 * `pg_get_functiondef(http_request)`.
 *
 * `pg_get_triggerdef()` answers all of it in one row per webhook: the events,
 * the table, and the arguments that make the webhook a webhook.
 */
interface WebhookEntry {
  /** `schema.table`, so two webhooks of the same name stay distinct. */
  table_name: string
  /** The table as SQL names it, quoted where it needs to be. */
  table_ref?: string
  /** The trigger name, which is what the Dashboard calls the webhook. */
  name: string
  /** `CREATE TRIGGER ...`, exactly as the server renders it. */
  definition: string
}

/** What identifies a webhook: a trigger name is only unique per table. */
function keyOf(entry: WebhookEntry): string {
  return `${entry.table_name}.${entry.name}`
}

export class WebhooksCheck extends Check {
  readonly name = 'webhooks' as const

  constructor(private queryFn: QueryFn = pgQuery) {
    super()
  }

  async scan(ctx: CheckContext): Promise<DriftIssue[]> {
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
        check: 'webhooks',
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
    return readOrAbsent(async () => await this.queryFn(dbUrl, HOOKS_SQL) as unknown as WebhookEntry[], [])
  }

  private async checkPgNet(dbUrl: string): Promise<boolean> {
    return readOrAbsent(async () => (await this.queryFn(dbUrl, PG_NET_CHECK_SQL)).length > 0, false)
  }
}

/**
 * Every trigger that calls Supabase's webhook function.
 *
 * That is the definition of a database webhook: the Dashboard creates one by
 * creating exactly this trigger. One row per webhook, a few hundred bytes,
 * whatever has happened to the invocation log.
 *
 * `tgisinternal` excludes the triggers PostgreSQL creates to enforce foreign
 * keys and constraints, which are not anybody's webhooks.
 */
const HOOKS_SQL = `
  SELECT n.nspname || '.' || c.relname AS table_name,
         format('%I.%I', n.nspname, c.relname) AS table_ref,
         t.tgname                      AS name,
         pg_get_triggerdef(t.oid)      AS definition
  FROM pg_trigger t
  JOIN pg_class c      ON c.oid = t.tgrelid
  JOIN pg_namespace n  ON n.oid = c.relnamespace
  JOIN pg_proc p       ON p.oid = t.tgfoid
  JOIN pg_namespace pn ON pn.oid = p.pronamespace
  WHERE NOT t.tgisinternal
    AND pn.nspname = 'supabase_functions'
    AND p.proname  = 'http_request'
  ORDER BY 1, 2
`

const PG_NET_CHECK_SQL = `
  SELECT 1 FROM pg_extension WHERE extname = 'pg_net'
`

/** `DROP TRIGGER IF EXISTS "name" ON schema.table;` */
function dropStatement(entry: WebhookEntry): string {
  return `DROP TRIGGER IF EXISTS ${quoteName(entry.name)} ON ${entry.table_ref ?? entry.table_name};`
}

/**
 * The server's own rendering, applied as-is.
 *
 * It already carries the URL, method, headers, params and timeout, so there is
 * nothing to reconstruct and no reason to touch `supabase_functions.http_request`
 * — which the previous fix recreated from the source project's copy, replacing
 * Supabase's own function as a side effect of syncing a webhook.
 */
function createStatement(entry: WebhookEntry): string {
  return `${entry.definition.replace(/;\s*$/, '')};`
}

function diffHooks(source: WebhookEntry[], target: WebhookEntry[]): DriftIssue[] {
  const issues: DriftIssue[] = []
  const sourceMap = new Map(source.map(h => [keyOf(h), h]))
  const targetMap = new Map(target.map(h => [keyOf(h), h]))

  for (const [key, h] of sourceMap) {
    if (targetMap.has(key)) continue

    issues.push({
      id: `webhooks-missing-${key}`,
      check: 'webhooks',
      severity: 'warning',
      title: `Missing webhook: ${h.name} on ${h.table_name}`,
      description: `Webhook "${h.name}" on ${h.table_name} exists in source but not in target.`,
      sourceValue: h,
      sql: {
        up: createStatement(h),
        down: dropStatement(h),
      },
    })
  }

  for (const [key, h] of targetMap) {
    if (sourceMap.has(key)) continue

    issues.push({
      id: `webhooks-extra-${key}`,
      check: 'webhooks',
      severity: 'info',
      title: `Extra webhook: ${h.name} on ${h.table_name}`,
      description: `Webhook "${h.name}" on ${h.table_name} exists in target but not in source.`,
      targetValue: h,
      // Removing one stops the target calling out, which nobody may notice
      // until something downstream goes quiet.
      destructive: 'removes a webhook',
      sql: {
        up: dropStatement(h),
        // Recoverable, unlike before: the target's own definition is the way back.
        down: createStatement(h),
      },
    })
  }

  // A webhook whose configuration differs. Comparing the full definition covers
  // the URL, method, headers, params and timeout as well as the events — the
  // previous comparison looked at the events and the table only, so a webhook
  // repointed at a different URL was reported as identical.
  for (const [key, sh] of sourceMap) {
    const th = targetMap.get(key)
    if (!th || normalise(sh.definition) === normalise(th.definition)) continue

    issues.push({
      id: `webhooks-modified-${key}`,
      check: 'webhooks',
      severity: 'warning',
      title: `Modified webhook: ${sh.name} on ${sh.table_name}`,
      description:
        `Webhook "${sh.name}" on ${sh.table_name} is configured differently in source and target.`,
      sourceValue: sh,
      targetValue: th,
      sql: {
        up: [dropStatement(th), createStatement(sh)].join('\n'),
        down: [dropStatement(sh), createStatement(th)].join('\n'),
      },
    })
  }

  return issues
}

/** Whitespace is not configuration. */
function normalise(definition: string): string {
  return definition.replace(/\s+/g, ' ').trim()
}
