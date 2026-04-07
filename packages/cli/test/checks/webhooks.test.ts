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

const makeHook = (overrides: Record<string, unknown> = {}) => ({
  id: 1,
  hook_table_id: 100,
  hook_name: 'on_user_created',
  created_at: '2026-01-01T00:00:00Z',
  request_id: null,
  function_body: null,
  events: null,
  trigger_table: null,
  ...overrides,
})

/** Hook with full trigger metadata — enables SQL generation */
const makeHookWithTrigger = (overrides: Record<string, unknown> = {}) => ({
  ...makeHook(),
  function_body: 'CREATE OR REPLACE FUNCTION supabase_functions.http_request() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END; $$',
  events: 'INSERT',
  trigger_table: 'public.users',
  ...overrides,
})

describe('WebhooksCheck', () => {
  it('returns no issues when hooks and extensions match', async () => {
    const hook = makeHook()
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_extension')) return [{ extname: 'pg_net' }]
      return [hook]
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('detects pg_net extension missing in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) {
        return dbUrl.includes('source') ? [{ extname: 'pg_net' }] : []
      }
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    const pgNetIssue = issues.find(i => i.id === 'webhooks-pgnet-missing')
    expect(pgNetIssue).toBeDefined()
    expect(pgNetIssue!.severity).toBe('critical')
    expect(pgNetIssue!.sql?.up).toContain('CREATE EXTENSION')
    expect(pgNetIssue!.sql?.down).toContain('DROP EXTENSION')
  })

  it('detects missing webhook in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('source')) return [makeHook()]
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('webhooks-missing-on_user_created')
    expect(issues[0].title).toContain('Missing webhook')
    // No sync SQL without trigger metadata
    expect(issues[0].sql).toBeUndefined()
  })

  it('detects extra webhook in target', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('target')) return [makeHook({ hook_name: 'extra_hook' })]
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('webhooks-extra-extra_hook')
    // No sync SQL without trigger metadata
    expect(issues[0].sql).toBeUndefined()
  })

  it('detects both pg_net missing and hook differences', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) {
        return dbUrl.includes('source') ? [{ extname: 'pg_net' }] : []
      }
      if (dbUrl.includes('source')) return [makeHook()]
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    const ids = issues.map(i => i.id)
    expect(ids).toContain('webhooks-pgnet-missing')
    expect(ids).toContain('webhooks-missing-on_user_created')
  })

  it('handles supabase_functions.hooks not existing', async () => {
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      throw new Error('relation "supabase_functions.hooks" does not exist')
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('handles pg_extension check failure gracefully', async () => {
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_extension')) throw new Error('connection refused')
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())
    // Both pg_net checks fail → false/false → no pg_net issue
    expect(issues).toHaveLength(0)
  })

  it('detects multiple missing hooks', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('source')) {
        return [
          makeHook({ hook_name: 'hook_a' }),
          makeHook({ hook_name: 'hook_b', id: 2 }),
        ]
      }
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    expect(issues[0].id).toBe('webhooks-missing-hook_a')
    expect(issues[1].id).toBe('webhooks-missing-hook_b')
  })

  it('no pg_net issue when both have it', async () => {
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_extension')) return [{ extname: 'pg_net' }]
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  // ── Sync SQL generation (with trigger metadata) ─────────────────────

  it('generates sync SQL for missing webhook with trigger metadata', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('source')) return [makeHookWithTrigger()]
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('CREATE TRIGGER')
    expect(issues[0].sql!.up).toContain('on_user_created')
    expect(issues[0].sql!.up).toContain('AFTER INSERT')
    expect(issues[0].sql!.up).toContain('public.users')
    expect(issues[0].sql!.down).toContain('DROP TRIGGER')
    expect(issues[0].sql!.down).toContain('on_user_created')
  })

  it('generates sync SQL for extra webhook with trigger table', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('target')) {
        return [makeHookWithTrigger({ hook_name: 'extra_hook' })]
      }
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].sql).toBeDefined()
    expect(issues[0].sql!.up).toContain('DROP TRIGGER')
    expect(issues[0].sql!.up).toContain('extra_hook')
  })

  it('includes trigger table in description when available', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_extension')) return []
      if (dbUrl.includes('source')) {
        return [makeHookWithTrigger({ events: 'INSERT OR UPDATE' })]
      }
      return []
    }

    const check = new WebhooksCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].description).toContain('public.users')
    expect(issues[0].description).toContain('INSERT OR UPDATE')
  })
})
