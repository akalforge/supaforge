import { describe, it, expect } from 'vitest'
import { RealtimeCheck } from '../../src/checks/realtime.js'
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

const makeRow = (overrides: Record<string, unknown> = {}) => ({
  pubname: 'my_pub',
  schemaname: 'public',
  tablename: 'users',
  ...overrides,
})

describe('RealtimeCheck', () => {
  it('detects missing publication in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeRow()]
      return []
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const missing = issues.find(i => i.id === 'realtime-missing-pub-my_pub')
    expect(missing).toBeDefined()
    expect(missing!.severity).toBe('warning')
    expect(missing!.sql?.up).toContain('CREATE PUBLICATION')
  })

  it('detects extra publication in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('target')) return [makeRow({ pubname: 'extra_pub' })]
      return []
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const extra = issues.find(i => i.id === 'realtime-extra-pub-extra_pub')
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
  })

  it('detects table membership drift in publication', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) {
        return [
          makeRow({ tablename: 'users' }),
          makeRow({ tablename: 'posts' }),
          makeRow({ tablename: 'comments' }),
        ]
      }
      return [makeRow({ tablename: 'users' })]
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const missingTable = issues.find(i => i.id === 'realtime-missing-table-my_pub-public.posts')
    expect(missingTable).toBeDefined()
    expect(missingTable!.severity).toBe('warning')
    expect(missingTable!.sql?.up).toContain('ALTER PUBLICATION')
  })

  it('detects extra published table in target', async () => {
    const queryFn: QueryFn = async (dbUrl) => {
      if (dbUrl.includes('source')) return [makeRow({ tablename: 'users' })]
      return [makeRow({ tablename: 'users' }), makeRow({ tablename: 'orders' })]
    }

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    const extra = issues.find(i => i.id === 'realtime-extra-table-my_pub-public.orders')
    expect(extra).toBeDefined()
    expect(extra!.severity).toBe('info')
  })

  it('returns no issues when publications match', async () => {
    const row = makeRow()
    const queryFn: QueryFn = async () => [row]

    const check = new RealtimeCheck(queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })
})
