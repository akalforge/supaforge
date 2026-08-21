import { describe, it, expect } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import { SchemaCheck } from '../../src/checks/schema.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { RunDbDiffFn } from '../../src/checks/schema.js'
import type { QueryFn } from '../../src/db.js'

function mockContext(): CheckContext {
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

/** A queryFn that returns no tables (simulates empty ignored schemas). */
const noTablesQuery: QueryFn = async () => []

describe('SchemaCheck', () => {
  it('has name "schema"', () => {
    const check = new SchemaCheck(async () => ({ up: '', down: '' }))
    expect(check.name).toBe('schema')
  })

  it('returns empty issues when no diff found', async () => {
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())
    expect(issues).toEqual([])
  })

  it('returns issues from @dbdiff/cli output', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].check).toBe('schema')
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].sql?.up).toContain('ADD COLUMN')
    expect(issues[0].sql?.down).toContain('DROP COLUMN')
  })

  it('classifies DROP TABLE as critical', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'DROP TABLE "legacy_data";',
      down: 'CREATE TABLE "legacy_data" (id int);',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('critical')
  })

  it('passes options to @dbdiff/cli', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await check.scan(mockContext())

    expect(capturedOptions).toMatchObject({
      type: 'schema',
      sourceUrl: 'postgres://source',
      targetUrl: 'postgres://target',
      ignoreSchemas: ['auth', 'storage'],
    })
  })

  it('skips with a reason when @dbdiff/cli is not installed', async () => {
    // Was: returned [], reporting the most important layer in the tool as
    // clean when it had not run at all (issue #42).
    const runFn: RunDbDiffFn = async () => {
      throw new Error('@dbdiff/cli is not installed. Install it with: npm install -g @dbdiff/cli')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow(CheckSkipped)
    await expect(check.scan(mockContext())).rejects.toThrow('@dbdiff/cli is not installed')
  })

  it('rethrows non-installation errors', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('Connection refused')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow('Connection refused')
  })

  it('reports error cleanly when dbdiff cannot connect (no output file)', async () => {
    const runFn: RunDbDiffFn = async () => {
      throw new Error('dbdiff failed with no error output')
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    await expect(check.scan(mockContext())).rejects.toThrow('dbdiff failed')
    await expect(check.scan(mockContext())).rejects.not.toThrow('Command failed:')
  })

  it('uses DEFAULT_IGNORE_SCHEMAS when config has no ignoreSchemas', async () => {
    let capturedOptions: unknown
    const runFn: RunDbDiffFn = async (opts) => {
      capturedOptions = opts
      return { up: '', down: '' }
    }
    const check = new SchemaCheck(runFn, noTablesQuery)
    const ctx = mockContext()
    delete ctx.config.ignoreSchemas
    await check.scan(ctx)

    const opts = capturedOptions as { ignoreSchemas?: string[] }
    expect(opts.ignoreSchemas).toBeDefined()
    expect(opts.ignoreSchemas!.length).toBeGreaterThan(0)
    expect(opts.ignoreSchemas).toContain('auth')
    expect(opts.ignoreSchemas).toContain('storage')
  })

  it('handles multiple statements', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;\nCREATE INDEX idx_bio ON users(bio);',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";\nDROP INDEX idx_bio;',
    })
    const check = new SchemaCheck(runFn, noTablesQuery)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(2)
    expect(issues[0].title).toContain('users')
    expect(issues[1].title).toContain('Index')
  })

  // ── Unqualified FK filtering via ignoredSchemaTables ─────────────────────

  it('filters unqualified FK when queryFn reports the referenced table is in an ignored schema', async () => {
    // This is the real-world case: auth was excluded from pg_dump, so local has no
    // projects_user_id_fkey. dbdiff outputs REFERENCES "users" (no schema prefix).
    // The queryFn simulates the target DB returning auth.users when queried.
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "projects" ADD CONSTRAINT "projects_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users" ("id") ON UPDATE NO ACTION ON DELETE CASCADE;',
      down: 'ALTER TABLE "projects" DROP CONSTRAINT "projects_user_id_fkey";',
    })
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_tables')) return [{ tablename: 'users' }, { tablename: 'refresh_tokens' }]
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('keeps unqualified FK when the referenced table does not live in an ignored schema', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "comments" ADD CONSTRAINT "comments_post_id_fkey" FOREIGN KEY ("post_id") REFERENCES "posts" ("id");',
      down: 'ALTER TABLE "comments" DROP CONSTRAINT "comments_post_id_fkey";',
    })
    // queryFn returns auth tables — "posts" is not among them
    const queryFn: QueryFn = async (_dbUrl, sql) => {
      if (sql.includes('pg_tables')) return [{ tablename: 'users' }]
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(1)
    expect(issues[0].sql?.up).toContain('ADD CONSTRAINT')
  })

  it('queries the TARGET database for ignored-schema tables (not source)', async () => {
    const queriedUrls: string[] = []
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const queryFn: QueryFn = async (dbUrl, sql) => {
      if (sql.includes('pg_tables')) queriedUrls.push(dbUrl)
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    await check.scan(mockContext())

    expect(queriedUrls).toHaveLength(1)
    expect(queriedUrls[0]).toBe('postgres://target')
  })

  it('passes ignoreSchemas as parameters to the pg_tables query', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const runFn: RunDbDiffFn = async () => ({ up: '', down: '' })
    const queryFn: QueryFn = async (_dbUrl, sql, params) => {
      calls.push({ sql, params })
      return []
    }
    const check = new SchemaCheck(runFn, queryFn)
    await check.scan(mockContext())

    const tablesCall = calls.find(c => c.sql.includes('pg_tables'))
    expect(tablesCall).toBeDefined()
    expect(tablesCall!.params).toEqual(['auth', 'storage'])
  })

  it('continues gracefully when queryFn throws (non-fatal)', async () => {
    const runFn: RunDbDiffFn = async () => ({
      up: 'ALTER TABLE "users" ADD COLUMN "bio" text;',
      down: 'ALTER TABLE "users" DROP COLUMN "bio";',
    })
    const queryFn: QueryFn = async () => { throw new Error('DB not reachable') }
    const check = new SchemaCheck(runFn, queryFn)
    const issues = await check.scan(mockContext())

    // The main diff result is still returned despite queryFn failure
    expect(issues).toHaveLength(1)
  })
})
