import { describe, it, expect } from 'vitest'
import { DataCheck } from '../../src/checks/data.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { RunDbDiffFn } from '../../src/checks/data.js'

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

describe('DataCheck', () => {
  it('has name "data"', () => {
    const check = new DataCheck(async () => ({ up: '', down: '' }))
    expect(check.name).toBe('data')
  })

  it('returns empty when no tables configured', async () => {
    const ctx: CheckContext = {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
      },
    }
    const check = new DataCheck(async () => ({ up: 'INSERT ...;', down: 'DELETE ...;' }))
    const issues = await check.scan(ctx)
    expect(issues).toEqual([])
  })

  it('returns empty when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const check = new DataCheck(runFn)
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from data diff output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: `INSERT INTO "plans" VALUES('3','premium','Premium Plan');`,
      down: `DELETE FROM "plans" WHERE "id" = '3';`,
    })
    const check = new DataCheck(runFn)
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
    const check = new DataCheck(runFn)
    await check.scan(mockContext(['plans', 'feature_flags']))

    expect(capturedOptions).toMatchObject({
      type: 'data',
      tables: ['plans', 'feature_flags'],
    })
  })

  it('returns empty when @dbdiff/cli is not installed', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const check = new DataCheck(runFn)
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const check = new DataCheck(runFn)
    await expect(check.scan(mockContext())).rejects.toThrow('Connection refused')
  })
})
