import { describe, it, expect } from 'vitest'
import { ExtensionsCheck } from '../../src/checks/extensions.js'
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

const makeExt = (overrides: Record<string, unknown> = {}) => ({
  name: 'pgcrypto',
  version: '1.3',
  schema: 'extensions',
  ...overrides,
})

describe('ExtensionsCheck', () => {
  it('detects missing extension in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt(), makeExt({ name: 'uuid-ossp', version: '1.1' })]
      return [makeExt()]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('uuid-ossp')
    expect(issues[0].sql?.up).toContain('CREATE EXTENSION')
    expect(issues[0].sql?.down).toContain('DROP EXTENSION')
  })

  it('detects extra extension in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makeExt(), makeExt({ name: 'postgis', version: '3.4' })]
      return [makeExt()]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('postgis')
  })

  it('detects version mismatch', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt({ version: '1.4' })]
      return [makeExt({ version: '1.3' })]
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].title).toContain('version mismatch')
    expect(issues[0].sql?.up).toContain("UPDATE TO '1.4'")
    expect(issues[0].sql?.down).toContain("UPDATE TO '1.3'")
  })

  it('returns no issues when extensions match', async () => {
    const ext = makeExt()
    const queryFn: QueryFn = async () => [ext]

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('includes schema in CREATE EXTENSION when not public', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt({ name: 'pg_stat_statements', schema: 'extensions' })]
      return []
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).toContain('SCHEMA "extensions"')
  })

  it('omits schema clause for public schema', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeExt({ schema: 'public' })]
      return []
    }

    const check = new ExtensionsCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues[0].sql?.up).not.toContain('SCHEMA')
  })
})
