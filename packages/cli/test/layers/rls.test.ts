import { describe, it, expect } from 'vitest'
import { RlsLayer } from '../../src/layers/rls.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): LayerContext {
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

describe('RlsLayer', () => {
  it('detects missing policies in target (CVE-2025-48757 pattern)', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return []
    }

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

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

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('Extra RLS policy')
  })

  it('detects modified USING expression', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return [makePolicy({ qual: '(true)' })]
    }

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

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

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('returns no issues when policies match', async () => {
    const policy = makePolicy()
    const queryFn: QueryFn = async () => [policy]

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

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

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].title).toContain('posts_read')
  })

  it('uses parameterized queries for schema filtering', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const queryFn: QueryFn = async (_dbUrl, sql, params) => {
      calls.push({ sql, params })
      return []
    }

    const layer = new RlsLayer(queryFn)
    await layer.scan(mockContext())

    expect(calls.length).toBe(2)
    expect(calls[0].sql).toContain('NOT IN')
    expect(calls[0].params).toEqual(['auth'])
  })

  it('generates valid CREATE POLICY SQL', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makePolicy()]
      return []
    }

    const layer = new RlsLayer(queryFn)
    const issues = await layer.scan(mockContext())

    const sql = issues[0].sql!.up
    expect(sql).toContain('CREATE POLICY "users_read"')
    expect(sql).toContain('ON "public"."users"')
    expect(sql).toContain('AS PERMISSIVE')
    expect(sql).toContain('FOR SELECT')
    expect(sql).toContain('TO authenticated')
    expect(sql).toContain('USING (')
  })
})
