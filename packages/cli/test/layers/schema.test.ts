import { describe, it, expect } from 'vitest'
import { SchemaLayer } from '../../src/layers/schema.js'
import type { LayerContext } from '../../src/layers/base.js'
import type { RunDbDiffFn } from '../../src/layers/schema.js'

function mockContext(): LayerContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      ignoreSchemas: ['auth', 'storage'],
    },
  }
}

describe('SchemaLayer', () => {
  it('has name "schema"', () => {
    const layer = new SchemaLayer(async () => ({ up: '', down: '' }))
    expect(layer.name).toBe('schema')
  })

  it('returns empty issues when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const layer = new SchemaLayer(runFn)
    const issues = await layer.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from @dbdiff/cli output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    })
    const layer = new SchemaLayer(runFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].layer).toBe('schema')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
    expect(issues[0].sql?.down).toContain('DROP COLUMN')
  })

  it('classifies DROP TABLE as critical', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'DROP TABLE "legacy_data";',
      down: 'CREATE TABLE "legacy_data" (id int);',
    })
    const layer = new SchemaLayer(runFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('passes options to @dbdiff/cli', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const layer = new SchemaLayer(runFn)
    await layer.scan(mockContext())

    expect(capturedOptions).toMatchObject({
      type: 'schema',
      sourceUrl: 'postgres://source',
      targetUrl: 'postgres://target',
    })
  })

  it('returns empty when @dbdiff/cli is not installed', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const layer = new SchemaLayer(runFn)
    const issues = await layer.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const layer = new SchemaLayer(runFn)
    await expect(layer.scan(mockContext())).rejects.toThrow('Connection refused')
  })

  it('handles multiple statements', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;\nCREATE INDEX idx_bio ON users(bio);',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";\nDROP INDEX idx_bio;',
    })
    const layer = new SchemaLayer(runFn)
    const issues = await layer.scan(mockContext())

    expect(issues).toHaveLength(2)
    expect(issues[0].title).toContain('users')
    expect(issues[1].title).toContain('Index')
  })
})
