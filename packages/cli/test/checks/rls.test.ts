import { describe, it, expect } from 'vitest'
import { RlsCheck, diffRlsStatus } from '../../src/checks/rls.js'
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
      ignoreSchemas: ['auth'],
    },
  }
}

const makePolicy = (overrides: Record<string, unknown> = {}) => ({
  schemaname: 'public',
  tablename: 'users',
  policyname: 'users_read',
  permissive: 'PERMISSIVE',
  roles: ['authenticated'],
  cmd: 'SELECT',
  qual: '(auth.uid() = id)',
  with_check: null,
  ...overrides,
})

describe('RlsCheck', () => {
  it('detects missing policies in target (CVE-2025-48757 pattern)', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return []
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('Missing RLS policy')
    expect(issues[0].description).toContain('CVE-2025-48757')
    expect(issues[0].sql?.up).toContain('CREATE POLICY')
    expect(issues[0].sql?.down).toContain('DROP POLICY')
  })

  it('detects extra policies in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makePolicy({ tablename: 'posts', policyname: 'posts_insert', cmd: 'INSERT' })]
      return []
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('Extra RLS policy')
  })

  it('detects modified USING expression', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return [makePolicy({ qual: '(true)' })]
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('Modified RLS policy')
    expect(issues[0].sourceValue).toBeTruthy()
    expect(issues[0].targetValue).toBeTruthy()
  })

  it('detects modified WITH CHECK expression', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy({ with_check: '(auth.uid() = user_id)' })]
      return [makePolicy({ with_check: '(true)' })]
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('returns no issues when policies match', async () => {
    const policy = makePolicy()
    const queryFn: QueryFn = async () => [policy]

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('handles multiple policies across tables', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      const policies = [
        makePolicy(),
        makePolicy({ tablename: 'posts', policyname: 'posts_read' }),
      ]
      if (dbUrl.includes('source')) return policies
      return [policies[0]] // missing posts_read in target
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('posts_read')
  })

  it('uses parameterized queries for schema filtering', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const queryFn: QueryFn = async (_dbUrl, sql, params) => {
      calls.push({ sql, params })
      return []
    }

    const check = new RlsCheck(queryFn)
    await check.scan(mockContext())

    // 4 calls: fetchPolicies × 2 + fetchTableRlsStatus × 2
    expect(calls.length).toBe(4)
    for (const call of calls) {
      expect(call.sql).toContain('NOT IN')
      expect(call.params).toEqual(['auth'])
    }
  })

  it('generates valid CREATE POLICY SQL', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return []
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    const sql = issues[0].sql!.up
    expect(sql).toContain('CREATE POLICY "users_read"')
    expect(sql).toContain('ON "public"."users"')
    expect(sql).toContain('AS PERMISSIVE')
    expect(sql).toContain('FOR SELECT')
    expect(sql).toContain('TO authenticated')
    expect(sql).toContain('USING (')
  })

  it('handles Postgres array literal roles format {role}', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      // pg driver may return name[] as raw string "{authenticated}"
      if (dbUrl.includes('source')) return [makePolicy({ roles: '{authenticated}' as unknown as string[] })]
      return []
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    const sql = issues[0].sql!.up
    expect(sql).toContain('TO authenticated')
    expect(sql).not.toContain('{')
  })
})

describe('diffRlsStatus', () => {
  const makeStatus = (overrides: Record<string, unknown> = {}) => ({
    schemaname: 'public',
    tablename: 'orders',
    rls_enabled: false,
    ...overrides,
  })

  it('detects RLS disabled in target when source has it enabled', () => {
    const source = [makeStatus({ rls_enabled: true })]
    const target = [makeStatus({ rls_enabled: false })]

    const issues = diffRlsStatus(source, target)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('rls-disabled-public.orders')
    expect(issues[0].severity).toBe('critical')
    expect(issues[0].title).toContain('RLS not enabled')
    expect(issues[0].sql?.up).toBe('ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;')
    expect(issues[0].sql?.down).toBe('ALTER TABLE "public"."orders" DISABLE ROW LEVEL SECURITY;')
  })

  it('detects RLS unexpectedly enabled in target', () => {
    const source = [makeStatus({ rls_enabled: false })]
    const target = [makeStatus({ rls_enabled: true })]

    const issues = diffRlsStatus(source, target)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('rls-enabled-public.orders')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].sql?.up).toBe('ALTER TABLE "public"."orders" DISABLE ROW LEVEL SECURITY;')
  })

  it('returns no issues when RLS status matches', () => {
    const source = [makeStatus({ rls_enabled: true })]
    const target = [makeStatus({ rls_enabled: true })]

    expect(diffRlsStatus(source, target)).toHaveLength(0)
  })

  it('skips tables absent from target (schema drift covers creation)', () => {
    const source = [makeStatus({ rls_enabled: true })]

    expect(diffRlsStatus(source, [])).toHaveLength(0)
  })

  it('handles multiple tables with mixed status', () => {
    const source = [
      makeStatus({ tablename: 'orders', rls_enabled: true }),
      makeStatus({ tablename: 'products', rls_enabled: false }),
      makeStatus({ tablename: 'users', rls_enabled: true }),
    ]
    const target = [
      makeStatus({ tablename: 'orders', rls_enabled: false }),
      makeStatus({ tablename: 'products', rls_enabled: false }),
      makeStatus({ tablename: 'users', rls_enabled: true }),
    ]

    const issues = diffRlsStatus(source, target)

    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('rls-disabled-public.orders')
  })

  it('RlsCheck.scan returns RLS status issues before policy issues', async () => {
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('relrowsecurity')) {
        // Status query
        if (dbUrl.includes('source')) return [{ schemaname: 'public', tablename: 'products', rls_enabled: true }]
        return [{ schemaname: 'public', tablename: 'products', rls_enabled: false }]
      }
      // Policy query — missing policy in target
      if (dbUrl.includes('source')) return [makePolicy({ tablename: 'products', policyname: 'products_read' })]
      return []
    }

    const check = new RlsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues.length).toBeGreaterThanOrEqual(2)
    // ENABLE RLS issue must come before the CREATE POLICY issue
    const enableIdx = issues.findIndex(i => i.id.includes('rls-disabled'))
    const policyIdx = issues.findIndex(i => i.id.includes('rls-missing'))
    expect(enableIdx).toBeLessThan(policyIdx)
    expect(issues[enableIdx].sql?.up).toContain('ENABLE ROW LEVEL SECURITY')
  })
})
