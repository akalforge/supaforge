import { describe, it, expect } from 'vitest'
import { RlsCoverageCheck } from '../../src/checks/rls-coverage.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(overrides: Partial<CheckContext> = {}): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      ignoreSchemas: ['auth', 'storage'],
    },
    ...overrides,
  }
}

const makeTable = (schemaname = 'public', tablename = 'users') => ({ schemaname, tablename })

describe('RlsCoverageCheck', () => {
  it('reports no issues when all target tables have RLS enabled', async () => {
    const queryFn: QueryFn = async () => []
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())
    expect(issues).toHaveLength(0)
  })

  it('reports critical issue for each table with RLS disabled', async () => {
    const queryFn: QueryFn = async () => [
      makeTable('public', 'users'),
      makeTable('public', 'posts'),
    ]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    for (const issue of issues) {
      expect(issue.check).toBe('rls-coverage')
      expect(issue.severity).toBe('critical')
    }
  })

  it('generates correct ENABLE RLS SQL fix', async () => {
    const queryFn: QueryFn = async () => [makeTable('public', 'orders')]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).toBe('ALTER TABLE "public"."orders" ENABLE ROW LEVEL SECURITY;')
    expect(issues[0].sql?.down).toBe('ALTER TABLE "public"."orders" DISABLE ROW LEVEL SECURITY;')
  })

  it('issue id encodes schema and table name', async () => {
    const queryFn: QueryFn = async () => [makeTable('app', 'secrets')]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].id).toBe('rls-coverage-app.secrets')
  })

  it('description mentions CVE-2025-48757', async () => {
    const queryFn: QueryFn = async () => [makeTable()]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].description).toContain('CVE-2025-48757')
  })

  it('targetValue contains schemaname and tablename', async () => {
    const queryFn: QueryFn = async () => [makeTable('myschema', 'mytable')]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].targetValue).toEqual({ schemaname: 'myschema', tablename: 'mytable' })
  })

  it('only queries the target database URL', async () => {
    const queriedUrls: string[] = []
    const queryFn: QueryFn = async (dbUrl) => {
      queriedUrls.push(dbUrl)
      return []
    }
    const check = new RlsCoverageCheck(queryFn)
    await check.scan(mockContext())

    expect(queriedUrls).toHaveLength(1)
    expect(queriedUrls[0]).toBe('postgres://target')
  })

  it('passes ignoreSchemas as query parameters', async () => {
    let capturedArgs: unknown[] | undefined
    const queryFn: QueryFn = async (_url, _sql, args) => {
      capturedArgs = args as unknown[]
      return []
    }
    const check = new RlsCoverageCheck(queryFn)
    await check.scan(mockContext())

    expect(capturedArgs).toEqual(['auth', 'storage'])
  })

  it('uses parameterless query when ignoreSchemas is empty', async () => {
    let capturedArgs: unknown[] | undefined
    const queryFn: QueryFn = async (_url, _sql, args) => {
      capturedArgs = args
      return []
    }
    const check = new RlsCoverageCheck(queryFn)
    const ctx = mockContext()
    ctx.config.ignoreSchemas = []
    await check.scan(ctx)

    expect(capturedArgs).toBeUndefined()
  })

  it('handles tables with special characters in names via quoting', async () => {
    const queryFn: QueryFn = async () => [makeTable('public', 'my-table')]
    const check = new RlsCoverageCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).toBe('ALTER TABLE "public"."my-table" ENABLE ROW LEVEL SECURITY;')
  })

  it('check name is rls-coverage', () => {
    const check = new RlsCoverageCheck()
    expect(check.name).toBe('rls-coverage')
  })
})
