import { describe, it, expect, vi } from 'vitest'
import {
  BOOTSTRAP_SQL,
  ensureMigrationsTable,
  getAppliedVersions,
  getPendingMigrations,
  runMigration,
  baselineMigrations,
} from '../src/migrate.js'
import type { QueryFn } from '../src/db.js'
import type { PendingMigration, ReadFileFn } from '../src/migrate.js'
import type { ReadDirFn } from '../src/checks/migrations.js'

// ─── ensureMigrationsTable ───────────────────────────────────────────────────

describe('ensureMigrationsTable', () => {
  it('executes bootstrap SQL', async () => {
    const calls: string[] = []
    const queryFn: QueryFn = async (_url, sql) => { calls.push(sql); return [] }

    await ensureMigrationsTable('postgres://test', queryFn)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain('CREATE SCHEMA IF NOT EXISTS supabase_migrations')
    expect(calls[0]).toContain('CREATE TABLE IF NOT EXISTS')
  })
})

// ─── getAppliedVersions ──────────────────────────────────────────────────────

describe('getAppliedVersions', () => {
  it('returns set of applied versions', async () => {
    const queryFn: QueryFn = async () => [
      { version: '001' },
      { version: '002' },
    ]

    const result = await getAppliedVersions('postgres://test', queryFn)

    expect(result).toBeInstanceOf(Set)
    expect(result.size).toBe(2)
    expect(result.has('001')).toBe(true)
    expect(result.has('002')).toBe(true)
  })

  it('returns empty set when no records', async () => {
    const queryFn: QueryFn = async () => []
    const result = await getAppliedVersions('postgres://test', queryFn)
    expect(result.size).toBe(0)
  })
})

// ─── getPendingMigrations ────────────────────────────────────────────────────

describe('getPendingMigrations', () => {
  it('filters out already-applied migrations', async () => {
    const readDirFn: ReadDirFn = async () => ['001_a.sql', '002_b.sql', '003_c.sql']
    const applied = new Set(['001', '002'])

    const pending = await getPendingMigrations('dir', applied, readDirFn)

    expect(pending).toHaveLength(1)
    expect(pending[0].version).toBe('003')
    expect(pending[0].path).toBe('dir/003_c.sql')
  })

  it('returns all when none applied', async () => {
    const readDirFn: ReadDirFn = async () => ['001_a.sql', '002_b.sql']
    const pending = await getPendingMigrations('dir', new Set(), readDirFn)
    expect(pending).toHaveLength(2)
  })

  it('returns empty when all applied', async () => {
    const readDirFn: ReadDirFn = async () => ['001_a.sql']
    const pending = await getPendingMigrations('dir', new Set(['001']), readDirFn)
    expect(pending).toHaveLength(0)
  })

  it('returns empty when dir is missing', async () => {
    const readDirFn: ReadDirFn = async () => { throw new Error('ENOENT') }
    const pending = await getPendingMigrations('missing', new Set(), readDirFn)
    expect(pending).toHaveLength(0)
  })
})

// ─── runMigration ────────────────────────────────────────────────────────────

describe('runMigration', () => {
  const migration: PendingMigration = {
    version: '003',
    name: 'add_roles',
    filename: '003_add_roles.sql',
    path: 'supabase/migrations/003_add_roles.sql',
  }

  it('executes migration SQL then records in schema_migrations', async () => {
    const calls: { sql: string; params?: unknown[] }[] = []
    const queryFn: QueryFn = async (_url, sql, params) => {
      calls.push({ sql, params })
      return []
    }
    const readFileFn: ReadFileFn = async () => 'CREATE TABLE roles (id int);'

    const result = await runMigration('postgres://test', migration, queryFn, readFileFn)

    expect(result.version).toBe('003')
    expect(result.name).toBe('add_roles')
    expect(result.durationMs).toBeGreaterThanOrEqual(0)

    // First call: execute migration
    expect(calls[0].sql).toBe('CREATE TABLE roles (id int);')
    // Second call: record in schema_migrations
    expect(calls[1].sql).toContain('INSERT INTO supabase_migrations.schema_migrations')
    expect(calls[1].params).toEqual(['003', 'add_roles', ['CREATE TABLE roles (id int);']])
  })

  it('reads from the correct file path', async () => {
    const paths: string[] = []
    const readFileFn: ReadFileFn = async (path) => { paths.push(path); return 'SELECT 1;' }
    const queryFn: QueryFn = async () => []

    await runMigration('postgres://test', migration, queryFn, readFileFn)

    expect(paths).toEqual(['supabase/migrations/003_add_roles.sql'])
  })

  it('propagates SQL execution errors', async () => {
    const queryFn: QueryFn = async (_url, sql) => {
      if (sql.includes('CREATE TABLE')) throw new Error('syntax error')
      return []
    }
    const readFileFn: ReadFileFn = async () => 'CREATE TABLE bad;'

    await expect(
      runMigration('postgres://test', migration, queryFn, readFileFn),
    ).rejects.toThrow('syntax error')
  })
})

// ─── baselineMigrations ──────────────────────────────────────────────────────

describe('baselineMigrations', () => {
  it('marks unapplied migrations and skips applied ones', async () => {
    const readDirFn: ReadDirFn = async () => ['001_a.sql', '002_b.sql', '003_c.sql']
    const inserts: unknown[][] = []
    let bootstrapped = false

    const queryFn: QueryFn = async (_url, sql, params) => {
      if (sql.includes('CREATE SCHEMA')) { bootstrapped = true; return [] }
      if (sql.includes('SELECT version')) return [{ version: '001' }]
      if (sql.includes('INSERT INTO')) { inserts.push(params ?? []); return [] }
      return []
    }

    const result = await baselineMigrations('postgres://test', 'dir', queryFn, readDirFn)

    expect(bootstrapped).toBe(true)
    expect(result.marked).toHaveLength(2)
    expect(result.marked[0].version).toBe('002')
    expect(result.marked[1].version).toBe('003')
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0].version).toBe('001')
  })

  it('returns empty when no local files', async () => {
    const readDirFn: ReadDirFn = async () => []
    const queryFn: QueryFn = async () => []

    const result = await baselineMigrations('postgres://test', 'dir', queryFn, readDirFn)

    expect(result.marked).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })

  it('marks all when DB has no records', async () => {
    const readDirFn: ReadDirFn = async () => ['001_a.sql', '002_b.sql']
    const queryFn: QueryFn = async (_url, sql) => {
      if (sql.includes('SELECT version')) return []
      return []
    }

    const result = await baselineMigrations('postgres://test', 'dir', queryFn, readDirFn)

    expect(result.marked).toHaveLength(2)
    expect(result.skipped).toHaveLength(0)
  })
})

// ─── BOOTSTRAP_SQL ───────────────────────────────────────────────────────────

describe('BOOTSTRAP_SQL', () => {
  it('creates schema and table', () => {
    expect(BOOTSTRAP_SQL).toContain('CREATE SCHEMA IF NOT EXISTS supabase_migrations')
    expect(BOOTSTRAP_SQL).toContain('CREATE TABLE IF NOT EXISTS supabase_migrations.schema_migrations')
    expect(BOOTSTRAP_SQL).toContain('version text PRIMARY KEY')
    expect(BOOTSTRAP_SQL).toContain('statements text[]')
    expect(BOOTSTRAP_SQL).toContain('name text')
  })
})

// ─── Edge cases ──────────────────────────────────────────────────────────────

describe('runMigration edge cases', () => {
  it('handles empty SQL file gracefully', async () => {
    const calls: { sql: string }[] = []
    const queryFn: QueryFn = async (_url, sql) => { calls.push({ sql }); return [] }
    const readFileFn: ReadFileFn = async () => ''

    const migration: PendingMigration = {
      version: '001', name: 'empty', filename: '001_empty.sql', path: 'dir/001_empty.sql',
    }
    const result = await runMigration('postgres://test', migration, queryFn, readFileFn)

    expect(result.version).toBe('001')
    // First call executes the empty string, second records it
    expect(calls).toHaveLength(2)
    expect(calls[0].sql).toBe('')
  })

  it('records migration even if SQL is whitespace-only', async () => {
    const queryFn: QueryFn = async () => []
    const readFileFn: ReadFileFn = async () => '   \n\n  '

    const migration: PendingMigration = {
      version: '002', name: 'whitespace', filename: '002_whitespace.sql', path: 'd/002_whitespace.sql',
    }
    const result = await runMigration('postgres://test', migration, queryFn, readFileFn)
    expect(result.version).toBe('002')
  })

  it('does not record migration when SQL execution fails', async () => {
    const recorded: string[] = []
    const queryFn: QueryFn = async (_url, sql) => {
      if (sql.includes('INSERT INTO')) recorded.push(sql)
      if (!sql.includes('INSERT')) throw new Error('fail')
      return []
    }
    const readFileFn: ReadFileFn = async () => 'BAD SQL;'

    const migration: PendingMigration = {
      version: '003', name: 'bad', filename: '003_bad.sql', path: 'd/003_bad.sql',
    }
    await expect(runMigration('postgres://test', migration, queryFn, readFileFn)).rejects.toThrow('fail')
    expect(recorded).toHaveLength(0)
  })
})

describe('baselineMigrations edge cases', () => {
  it('handles dir read failure gracefully (empty baseline)', async () => {
    const readDirFn: ReadDirFn = async () => { throw new Error('ENOENT') }
    const queryFn: QueryFn = async () => []

    const result = await baselineMigrations('postgres://test', 'missing', queryFn, readDirFn)
    expect(result.marked).toHaveLength(0)
    expect(result.skipped).toHaveLength(0)
  })
})
