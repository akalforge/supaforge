import { describe, it, expect, vi } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import { DataCheck } from '../../src/checks/data.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { RunDbDiffFn } from '../../src/checks/data.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(tables?: string[]): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      checks: { data: { tables: tables ?? ['plans', 'feature_flags'] } },
    },
  }
}

/**
 * Mock queryFn that makes all tables appear "changed" — different fingerprints
 * between source and target so they pass through to the actual diff.
 */
function mockChangedQueryFn(): QueryFn {
  let callCount = 0
  return vi.fn(async () => {
    callCount++
    // Alternate: even calls = source fingerprint, odd = target (different size)
    return [{ row_count: 10, size_bytes: String(callCount % 2 === 0 ? 1024 : 2048) }]
  })
}

describe('DataCheck', () => {
  it('has name "data"', () => {
    const check = new DataCheck(async () => ({ up: '', down: '' }), mockChangedQueryFn())
    expect(check.name).toBe('data')
  })

  it('skips with a reason when no tables configured', async () => {
    const ctx: CheckContext = {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
      },
    }
    // Nothing configured to compare is a skip, not a clean comparison — this
    // layer reported a green pass having read nothing at all (issue #42).
    const check = new DataCheck(async () => ({ up: 'INSERT ...;', down: 'DELETE ...;' }), mockChangedQueryFn())
    await expect(check.scan(ctx)).rejects.toThrow(CheckSkipped)
    await expect(check.scan(ctx)).rejects.toThrow('no tables configured in checks.data.tables')
  })

  it('returns empty when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const check = new DataCheck(runFn, mockChangedQueryFn())
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from data diff output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: `INSERT INTO "plans" VALUES('3','premium','Premium Plan');`,
      down: `DELETE FROM "plans" WHERE "id" = '3';`,
    })
    const check = new DataCheck(runFn, mockChangedQueryFn())
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].check).toBe('data')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].title).toContain('plans')
    expect(issues[0].sql?.up).toContain('INSERT INTO')
  })

  it('passes tables to @dbdiff/cli', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const check = new DataCheck(runFn, mockChangedQueryFn())
    await check.scan(mockContext(['plans', 'feature_flags']))

    expect(capturedOptions).toMatchObject({
      type: 'data',
    })
  })

  it('returns empty when @dbdiff/cli is not installed', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const check = new DataCheck(runFn, mockChangedQueryFn())
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const check = new DataCheck(runFn, mockChangedQueryFn())
    await expect(check.scan(mockContext())).rejects.toThrow('Connection refused')
  })
})

// ─── issue #43: the data layer narrows its own configured list ──────────────

describe('DataCheck honours the table filter (issue #43)', () => {
  const configured = ['plans', 'plan_features', 'plans_audit']

  function ctxWith(tableFilter?: CheckContext['tableFilter']): CheckContext {
    return {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
        checks: { data: { tables: configured } },
      },
      ...(tableFilter ? { tableFilter } : {}),
    }
  }

  /**
   * Fingerprints are computed one table at a time with the name inlined into
   * the SQL, so the tables actually read are recovered from the statements.
   */
  function capturingQueryFn(): { tablesRead: () => string[]; queryFn: QueryFn } {
    const sqls: string[] = []
    let callCount = 0
    const queryFn: QueryFn = async (_url, sql) => {
      sqls.push(sql)
      callCount++
      // Always differ, so nothing is short-circuited as unchanged.
      return [{ row_count: 10, size_bytes: String(callCount % 2 === 0 ? 1024 : 2048) }]
    }
    return {
      queryFn,
      tablesRead: () => [...new Set(configured.filter(t => sqls.some(q => q.includes(t))))],
    }
  }

  it('only fingerprints the tables in scope', async () => {
    // Narrowed before the checksum pass, not after — otherwise an excluded
    // table is still read from both databases for nothing.
    const { queryFn, tablesRead } = capturingQueryFn()
    await new DataCheck(async () => ({ up: '', down: '' }), queryFn).scan(ctxWith({ tables: ['plans'] }))
    expect(tablesRead()).toEqual(['plans'])
  })

  it('applies globs from the filter', async () => {
    const { queryFn, tablesRead } = capturingQueryFn()
    await new DataCheck(async () => ({ up: '', down: '' }), queryFn).scan(ctxWith({ excludeTables: ['*_audit'] }))
    expect(tablesRead()).toEqual(['plans', 'plan_features'])
  })

  it('passes only the in-scope tables to dbdiff', async () => {
    const calls: Array<string[] | undefined> = []
    const { queryFn } = capturingQueryFn()
    const runFn = async (opts: { tables?: string[] }) => {
      calls.push(opts.tables)
      return { up: '', down: '' }
    }
    await new DataCheck(runFn as never, queryFn).scan(ctxWith({ tables: ['plans'] }))
    expect(calls[0]).toEqual(['plans'])
  })

  it('is unchanged when no filter is set', async () => {
    const { queryFn, tablesRead } = capturingQueryFn()
    await new DataCheck(async () => ({ up: '', down: '' }), queryFn).scan(ctxWith())
    expect(tablesRead()).toEqual(configured)
  })

  it('skips with a reason when the filter excludes every configured table', async () => {
    // Not a clean pass: nothing was compared. Same distinction issue #42 drew.
    const check = new DataCheck(async () => ({ up: '', down: '' }), mockChangedQueryFn())
    await expect(check.scan(ctxWith({ tables: ['not_configured'] }))).rejects.toThrow(CheckSkipped)
    await expect(check.scan(ctxWith({ tables: ['not_configured'] })))
      .rejects.toThrow('no configured data tables match')
  })

})
