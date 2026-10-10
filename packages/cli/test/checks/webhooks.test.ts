import { describe, it, expect } from 'vitest'
import { WebhooksCheck } from '../../src/checks/webhooks.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
    },
  }
}

/**
 * A webhook as the catalog holds it: a trigger calling
 * supabase_functions.http_request with the URL, method, headers, params and
 * timeout as arguments.
 *
 * The check used to read `supabase_functions.hooks` — the log of webhook
 * *invocations* — which is what issue #77 is about. These fixtures are the
 * shape of the answer, one row per webhook however often it has fired.
 */
const hook = (
  table: string,
  name: string,
  url = `https://example.invalid/${name}`,
  events = 'AFTER INSERT',
) => ({
  table_name: table,
  name,
  definition:
    `CREATE TRIGGER ${name} ${events} ON ${table} FOR EACH ROW `
    + `EXECUTE FUNCTION supabase_functions.http_request(`
    + `'${url}', 'POST', '{"Content-Type":"application/json"}', '{}', '5000')`,
})

/** Answer the webhook query per side; pg_net present on both. */
function queryFor(source: unknown[], target: unknown[]): QueryFn {
  return (async (dbUrl: string, sql: string) => {
    if (sql.includes('pg_extension')) return [{ n: 1 }]
    return dbUrl.includes('target') ? target : source
  }) as unknown as QueryFn
}

describe('WebhooksCheck', () => {
  it('reports nothing when both sides match', async () => {
    const both = [hook('public.orders', 'orders_webhook')]
    const issues = await new WebhooksCheck(queryFor(both, both)).scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('reads one row per webhook, whatever the invocation log holds', async () => {
    // The query must go to the trigger catalog. Reading the log made cost grow
    // with invocations — 10,000 rows returned 21.9 MB for five webhooks, each
    // row carrying its own copy of pg_get_functiondef(http_request).
    let seen = ''
    const queryFn = (async (_url: string, sql: string) => {
      if (!sql.includes('pg_extension')) seen = sql
      return []
    }) as unknown as QueryFn

    await new WebhooksCheck(queryFn).scan(mockContext())

    expect(seen).toContain('pg_trigger')
    expect(seen).toContain('pg_get_triggerdef')
    expect(seen).not.toContain('supabase_functions.hooks')
    expect(seen).not.toContain('pg_get_functiondef')
  })

  // ── The symptoms of reading the log (issue #77) ───────────────────────────

  it('sees a webhook that has never fired', async () => {
    // It has no log rows, so it used to be invisible.
    const issues = await new WebhooksCheck(
      queryFor([hook('public.invoices', 'invoices_webhook')], []),
    ).scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('invoices_webhook')
  })

  it('does not report a webhook that was deleted', async () => {
    // Its log rows outlive it, so a deleted webhook was reported as missing
    // from the target — and offered with no usable fix.
    const issues = await new WebhooksCheck(queryFor([], [])).scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('keeps two webhooks that share a trigger name on different tables', async () => {
    // Entries were keyed by name alone, so these collapsed into one and the
    // other table's webhook was silently lost.
    const issues = await new WebhooksCheck(
      queryFor(
        [hook('public.a_items', 'notify_webhook', 'https://example.invalid/a'),
         hook('public.b_items', 'notify_webhook', 'https://example.invalid/b')],
        [],
      ),
    ).scan(mockContext())

    expect(issues).toHaveLength(2)
    expect(issues.map(i => i.id).sort()).toEqual([
      'webhooks-missing-public.a_items.notify_webhook',
      'webhooks-missing-public.b_items.notify_webhook',
    ])
  })

  it('notices a changed URL', async () => {
    // "Modified" compared the events and the table only, so the whole of a
    // webhook's configuration could change unreported.
    const issues = await new WebhooksCheck(
      queryFor(
        [hook('public.customers', 'customers_webhook', 'https://example.invalid/v2/customers')],
        [hook('public.customers', 'customers_webhook', 'https://example.invalid/v1/customers')],
      ),
    ).scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('Modified webhook')
    expect(issues[0].sql?.up).toContain('v2/customers')
  })

  it('notices changed events', async () => {
    const issues = await new WebhooksCheck(
      queryFor(
        [hook('public.orders', 'orders_webhook', 'https://e.invalid/o', 'AFTER INSERT OR UPDATE')],
        [hook('public.orders', 'orders_webhook', 'https://e.invalid/o', 'AFTER INSERT')],
      ),
    ).scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('Modified webhook')
  })

  it('ignores whitespace when comparing', async () => {
    const source = [hook('public.orders', 'orders_webhook')]
    const target = [{
      ...source[0],
      definition: source[0].definition.replace(/ /g, '\n  '),
    }]

    const issues = await new WebhooksCheck(queryFor(source, target)).scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  // ── The fix it generates ──────────────────────────────────────────────────

  it('applies the definition with its arguments', async () => {
    // The old fix emitted `http_request()` with no arguments, after which every
    // insert on the target failed with `url argument is missing`.
    const issues = await new WebhooksCheck(
      queryFor([hook('public.orders', 'orders_webhook')], []),
    ).scan(mockContext())

    const up = issues[0].sql?.up ?? ''
    expect(up).toContain("'https://example.invalid/orders_webhook'")
    expect(up).toContain("'POST'")
    expect(up).toContain("'5000'")
    expect(up).not.toMatch(/http_request\(\s*\)/)
  })

  it('does not touch Supabase\'s own http_request function', async () => {
    // The old fix recreated it from the source project's copy as a side effect
    // of syncing a webhook.
    const issues = await new WebhooksCheck(
      queryFor([hook('public.orders', 'orders_webhook')], []),
    ).scan(mockContext())

    expect(issues[0].sql?.up).not.toContain('CREATE OR REPLACE FUNCTION')
    expect(issues[0].sql?.down).not.toContain('CREATE OR REPLACE FUNCTION')
  })

  it('ends every statement with a semicolon, exactly one', async () => {
    const issues = await new WebhooksCheck(
      queryFor([hook('public.orders', 'orders_webhook')], []),
    ).scan(mockContext())

    expect(issues[0].sql?.up.trimEnd().endsWith(';')).toBe(true)
    expect(issues[0].sql?.up).not.toContain(';;')
  })

  it('reverses a missing webhook by dropping it', async () => {
    const issues = await new WebhooksCheck(
      queryFor([hook('public.orders', 'orders_webhook')], []),
    ).scan(mockContext())

    expect(issues[0].sql?.down).toBe('DROP TRIGGER IF EXISTS "orders_webhook" ON public.orders;')
  })

  it('offers a way back for an extra webhook', async () => {
    // The old fix left `down` empty, calling the drop unrecoverable, although
    // the target's own definition is the way back.
    const issues = await new WebhooksCheck(
      queryFor([], [hook('public.legacy', 'legacy_webhook')]),
    ).scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].sql?.up).toContain('DROP TRIGGER IF EXISTS "legacy_webhook"')
    expect(issues[0].sql?.down).toContain('CREATE TRIGGER legacy_webhook')
  })

  it('marks removing an extra webhook as destructive', async () => {
    const [issue] = await new WebhooksCheck(
      queryFor([], [hook('public.legacy', 'legacy_webhook')]),
    ).scan(mockContext())
    expect(issue.destructive).toBe('removes a webhook')
  })

  it('names the table in the issue, so two of one name are distinguishable', async () => {
    const issues = await new WebhooksCheck(
      queryFor([hook('public.a_items', 'notify_webhook')], []),
    ).scan(mockContext())

    expect(issues[0].title).toContain('public.a_items')
    expect(issues[0].description).toContain('public.a_items')
  })

  // ── pg_net, unchanged ─────────────────────────────────────────────────────

  it('detects pg_net missing in the target', async () => {
    const queryFn = (async (dbUrl: string, sql: string) => {
      if (sql.includes('pg_extension')) return dbUrl.includes('target') ? [] : [{ n: 1 }]
      return []
    }) as unknown as QueryFn

    const issues = await new WebhooksCheck(queryFn).scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('webhooks-pgnet-missing')
    expect(issues[0].severity).toBe('critical')
  })

  it('reports no pg_net issue when both sides have it', async () => {
    const issues = await new WebhooksCheck(queryFor([], [])).scan(mockContext())
    expect(issues.filter(i => i.id === 'webhooks-pgnet-missing')).toHaveLength(0)
  })

  it('survives a database with no supabase_functions schema', async () => {
    const queryFn = (async (_url: string, sql: string) => {
      if (sql.includes('pg_extension')) return []
      throw Object.assign(new Error('relation "supabase_functions.hooks" does not exist'), { code: '42P01' })
    }) as unknown as QueryFn

    await expect(new WebhooksCheck(queryFn).scan(mockContext())).resolves.toEqual([])
  })

  it('reports pg_net and webhook differences together', async () => {
    const queryFn = (async (dbUrl: string, sql: string) => {
      if (sql.includes('pg_extension')) return dbUrl.includes('target') ? [] : [{ n: 1 }]
      return dbUrl.includes('target') ? [] : [hook('public.orders', 'orders_webhook')]
    }) as unknown as QueryFn

    const issues = await new WebhooksCheck(queryFn).scan(mockContext())

    expect(issues.map(i => i.id)).toContain('webhooks-pgnet-missing')
    expect(issues.map(i => i.id)).toContain('webhooks-missing-public.orders.orders_webhook')
  })
})
