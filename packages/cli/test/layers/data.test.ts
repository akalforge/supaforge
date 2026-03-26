import { describe, it, expect } from 'vitest'
import { DataLayer } from '../../src/layers/data.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { RunDbDiffFn } from '../../src/layers/data.js'

function mockContext(tables?: string[]): LayerContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      layers: { data: { tables: tables ?? ['plans', 'feature_flags'] } },
    },
  }
}

describe('DataLayer', () => {
  it('has name "data"', () => {
    const layer = new DataLayer(async () => ({ up: '', down: '' }))
    expect(layer.name).toBe('data')
  })

  it('returns empty when no tables configured', async () => {
    const ctx: LayerContext = {
      source: { dbUrl: 'postgres://source' },
      target: { dbUrl: 'postgres://target' },
      config: {
        environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
        source: 'dev',
        target: 'prod',
      },
    }
    const layer = new DataLayer(async () => ({ up: 'INSERT ...;', down: 'DELETE ...;' }))
    const issues = await layer.scan(ctx)
    expect(issues).toEqual([])
  })

  it('returns empty when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const layer = new DataLayer(runFn)
    const issues = await layer.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from data diff output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: `INSERT INTO "plans" VALUES('3','premium','Premium Plan');`,
      down: `DELETE FROM "plans" WHERE "id" = '3';`,
    })
    const layer = new DataLayer(runFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].layer).toBe('data')
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
    const layer = new DataLayer(runFn)
    await layer.scan(mockContext(['plans', 'feature_flags']))

    expect(capturedOptions).toMatchObject({
      type: 'data',
      tables: ['plans', 'feature_flags'],
    })
  })

  it('returns empty when @dbdiff/cli is not installed', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const layer = new DataLayer(runFn)
    const issues = await layer.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const layer = new DataLayer(runFn)
    await expect(layer.scan(mockContext())).rejects.toThrow('Connection refused')
  })
})
