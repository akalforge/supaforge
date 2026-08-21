import { describe, it, expect, vi } from 'vitest'
import { CheckSkipped } from '../../src/checks/base.js'
import {
  MigrationsCheck,
  parseFilename,
  diffMigrations,
  readLocalMigrations,
  resolveMigrationsMode,
  DEFAULT_MIGRATIONS_DIR,
} from '../../src/checks/migrations.js'
import type { CheckContext } from '../../src/checks/base.js'
import type { QueryFn } from '../../src/db.js'
import type { LocalMigration, ReadDirFn } from '../../src/checks/migrations.js'

function mockContext(overrides: Partial<CheckContext['config']> = {}): CheckContext {
  return {
    source: { dbUrl: 'postgres://source' },
    target: { dbUrl: 'postgres://target' },
    config: {
      environments: { dev: { dbUrl: '' }, prod: { dbUrl: '' } },
      source: 'dev',
      target: 'prod',
      ...overrides,
    },
  }
}

// ─── parseFilename ───────────────────────────────────────────────────────────

describe('parseFilename', () => {
  it('parses Supabase-style timestamp filename', () => {
    expect(parseFilename('20240101000000_create_users.sql')).toEqual({
      version: '20240101000000',
      name: 'create_users',
    })
  })

  it('parses sequential numeric prefix', () => {
    expect(parseFilename('001_initial_schema.sql')).toEqual({
      version: '001',
      name: 'initial_schema',
    })
  })

  it('returns null for files without version prefix', () => {
    expect(parseFilename('readme.sql')).toBeNull()
  })

  it('returns null for non-sql files', () => {
    expect(parseFilename('001_setup.txt')).toBeNull()
  })

  it('returns null for files without underscore separator', () => {
    expect(parseFilename('20240101.sql')).toBeNull()
  })

  it('handles names with multiple underscores', () => {
    expect(parseFilename('002_add_user_roles.sql')).toEqual({
      version: '002',
      name: 'add_user_roles',
    })
  })
})

// ─── readLocalMigrations ─────────────────────────────────────────────────────

describe('readLocalMigrations', () => {
  it('reads .sql files and parses them', async () => {
    const readDirFn: ReadDirFn = async () => [
      '001_initial.sql',
      '002_add_users.sql',
      'readme.txt',
    ]
    const result = await readLocalMigrations('some/dir', readDirFn)
    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ version: '001', name: 'initial', filename: '001_initial.sql' })
    expect(result[1]).toEqual({ version: '002', name: 'add_users', filename: '002_add_users.sql' })
  })

  it('returns empty array when dir does not exist', async () => {
    const readDirFn: ReadDirFn = async () => { throw new Error('ENOENT') }
    const result = await readLocalMigrations('missing/dir', readDirFn)
    expect(result).toEqual([])
  })

  it('skips files without valid version prefix', async () => {
    const readDirFn: ReadDirFn = async () => ['migration.sql', '001_setup.sql']
    const result = await readLocalMigrations('dir', readDirFn)
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('001')
  })

  it('returns sorted files', async () => {
    const readDirFn: ReadDirFn = async () => ['003_c.sql', '001_a.sql', '002_b.sql']
    const result = await readLocalMigrations('dir', readDirFn)
    expect(result.map(m => m.version)).toEqual(['001', '002', '003'])
  })
})

// ─── diffMigrations ──────────────────────────────────────────────────────────

describe('diffMigrations', () => {
  const local: LocalMigration[] = [
    { version: '001', name: 'initial', filename: '001_initial.sql' },
    { version: '002', name: 'add_users', filename: '002_add_users.sql' },
    { version: '003', name: 'add_roles', filename: '003_add_roles.sql' },
  ]

  it('detects unapplied migrations', () => {
    const db = [{ version: '001', name: 'initial' }]
    const issues = diffMigrations(local, db)

    const unapplied = issues.filter(i => i.id.startsWith('migration-unapplied'))
    expect(unapplied).toHaveLength(2)
    expect(unapplied[0].severity).toBe('warning')
    expect(unapplied[0].title).toContain('002_add_users.sql')
    expect(unapplied[0].sql?.up).toContain('INSERT INTO supabase_migrations.schema_migrations')
    expect(unapplied[0].sql?.up).toContain('002')
    expect(unapplied[0].sql?.down).toContain('DELETE FROM')
  })

  it('detects untracked migrations (in DB but not on disk)', () => {
    const db = [
      { version: '001', name: 'initial' },
      { version: '999', name: 'mystery' },
    ]
    const issues = diffMigrations(local, db)

    const untracked = issues.filter(i => i.id.startsWith('migration-untracked'))
    expect(untracked).toHaveLength(1)
    expect(untracked[0].severity).toBe('info')
    expect(untracked[0].title).toContain('999')
    expect(untracked[0].description).toContain('mystery')
  })

  it('returns no issues when in sync', () => {
    const db = local.map(m => ({ version: m.version, name: m.name }))
    const issues = diffMigrations(local, db)
    expect(issues).toHaveLength(0)
  })

  it('returns no issues when both empty', () => {
    expect(diffMigrations([], [])).toHaveLength(0)
  })

  it('reports every local file in warn mode when DB has no records', () => {
    const issues = diffMigrations(local, [], 'warn')
    expect(issues).toHaveLength(3)
    expect(issues.every(i => i.id.startsWith('migration-unapplied'))).toBe(true)
  })

  it('all DB records are untracked when no local files', () => {
    const db = [{ version: '001', name: 'x' }, { version: '002', name: 'y' }]
    const issues = diffMigrations([], db)
    expect(issues).toHaveLength(2)
    expect(issues.every(i => i.id.startsWith('migration-untracked'))).toBe(true)
  })

  it('untracked issue description handles null name', () => {
    const issues = diffMigrations([], [{ version: '777', name: null }])
    expect(issues[0].description).not.toContain('null')
    expect(issues[0].description).toContain('777')
  })

  it('mark-applied SQL uses ON CONFLICT DO NOTHING', () => {
    const issues = diffMigrations(local.slice(0, 1), [], 'warn')
    expect(issues[0].sql?.up).toContain('ON CONFLICT (version) DO NOTHING')
  })

  it('mark-applied SQL uses MIGRATIONS_TABLE constant', () => {
    const issues = diffMigrations(local.slice(0, 1), [], 'warn')
    expect(issues[0].sql?.up).toContain('supabase_migrations.schema_migrations')
    expect(issues[0].sql?.down).toContain('supabase_migrations.schema_migrations')
  })

  it('mark-applied SQL safely escapes single quotes in version', () => {
    const malicious: LocalMigration[] = [
      { version: "001'; DROP TABLE users; --", name: 'exploit', filename: "001'; DROP TABLE users; --.sql" },
    ]
    const issues = diffMigrations(malicious, [], 'warn')
    const sql = issues[0].sql?.up ?? ''
    // quoteLiteral doubles single quotes — verify no unescaped injection
    expect(sql).toContain("'001''; DROP TABLE users; --'")
    expect(sql).not.toContain("001'; DROP")
  })

  it('mark-applied SQL safely escapes single quotes in name', () => {
    const malicious: LocalMigration[] = [
      { version: '001', name: "test' OR '1'='1", filename: "001_test.sql" },
    ]
    const issues = diffMigrations(malicious, [], 'warn')
    const sql = issues[0].sql?.up ?? ''
    expect(sql).toContain("'test'' OR ''1''=''1'")
  })

  it('delete SQL uses quoteLiteral for version', () => {
    const issues = diffMigrations(local.slice(0, 1), [], 'warn')
    // Should be quoted with single quotes via quoteLiteral
    expect(issues[0].sql?.down).toContain("WHERE version = '001'")
  })
})

// ─── MigrationsCheck.scan ────────────────────────────────────────────────────

describe('MigrationsCheck', () => {
  it('uses default migrations dir when config.checks.migrations is unset', async () => {
    const dirs: string[] = []
    const readDirFn: ReadDirFn = async (dir) => { dirs.push(dir); return [] }
    const queryFn: QueryFn = async () => []

    const check = new MigrationsCheck(queryFn, readDirFn)
    await check.scan(mockContext())

    expect(dirs[0]).toBe(DEFAULT_MIGRATIONS_DIR)
  })

  it('uses custom dir from config', async () => {
    const dirs: string[] = []
    const readDirFn: ReadDirFn = async (dir) => { dirs.push(dir); return [] }
    const queryFn: QueryFn = async () => []

    const check = new MigrationsCheck(queryFn, readDirFn)
    await check.scan(mockContext({ checks: { migrations: { dir: 'custom/path' } } }))

    expect(dirs[0]).toBe('custom/path')
  })

  it('returns unapplied when local files exist but DB is empty', async () => {
    const readDirFn: ReadDirFn = async () => ['001_setup.sql', '002_data.sql']
    const queryFn: QueryFn = async () => []

    const check = new MigrationsCheck(queryFn, readDirFn)
    const issues = await check.scan(mockContext())

    // Default 'auto' mode: nothing tracked at all, so one INFO about the
    // workflow rather than a warning per file (issue #31).
    expect(issues).toHaveLength(1)
    expect(issues[0].check).toBe('migrations')
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('migration-workflow-untracked')
  })

  it('returns clean when files match DB records', async () => {
    const readDirFn: ReadDirFn = async () => ['001_setup.sql']
    const queryFn: QueryFn = async () => [{ version: '001', name: 'setup' }]

    const check = new MigrationsCheck(queryFn, readDirFn)
    const issues = await check.scan(mockContext())

    expect(issues).toHaveLength(0)
  })

  it('handles DB query failure gracefully (table does not exist)', async () => {
    const readDirFn: ReadDirFn = async () => ['001_setup.sql']
    const queryFn: QueryFn = async () => { throw new Error('relation does not exist') }

    const check = new MigrationsCheck(queryFn, readDirFn)
    const issues = await check.scan(mockContext())

    // The tracking table does not exist, so nothing is tracked — same shape
    // as the untracked workflow, reported once (issue #31).
    expect(issues).toHaveLength(1)
    expect(issues[0].id).toBe('migration-workflow-untracked')
    expect(issues[0].severity).toBe('info')
  })

  it('queries the target DB, not the source', async () => {
    const queriedUrls: string[] = []
    const queryFn: QueryFn = async (dbUrl) => { queriedUrls.push(dbUrl); return [] }
    const readDirFn: ReadDirFn = async () => []

    const check = new MigrationsCheck(queryFn, readDirFn)
    await check.scan(mockContext())

    expect(queriedUrls).toEqual(['postgres://target'])
  })

  it('name property is migrations', () => {
    const check = new MigrationsCheck(async () => [], async () => [])
    expect(check.name).toBe('migrations')
  })
})

// ── Regression: issue #31 ─────────────────────────────────────────────────
// "Migration history check reports false positives for manually-applied
// migrations". schema_migrations is a Supabase CLI convention, not a database
// requirement — projects applying migrations via psql never populate it, so
// every local file was reported as unapplied on every scan.

describe('untracked migration workflow (issue #31)', () => {
  const local: LocalMigration[] = [
    { version: '001', name: 'initial', filename: '001_initial.sql' },
    { version: '002', name: 'add_users', filename: '002_add_users.sql' },
    { version: '003', name: 'add_roles', filename: '003_add_roles.sql' },
  ]

  it('reports one INFO instead of a warning per file when nothing is tracked', () => {
    const issues = diffMigrations(local, [])
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('info')
    expect(issues[0].id).toBe('migration-workflow-untracked')
    expect(issues[0].title).toContain('3 local files')
  })

  it('explains how to record or silence them', () => {
    const [issue] = diffMigrations(local, [])
    expect(issue.description).toContain('migrate baseline')
    expect(issue.description).toContain('checks.migrations.mode')
  })

  it('singularises for a lone migration file', () => {
    const issues = diffMigrations(local.slice(0, 1), [])
    expect(issues[0].title).toContain('1 local file')
  })

  it('does NOT collapse when some migrations are tracked — that is real drift', () => {
    // A project that tracks some and missed others has genuine drift, and
    // must still get one actionable warning per missing file.
    const issues = diffMigrations(local, [{ version: '001', name: 'initial' }])
    expect(issues).toHaveLength(2)
    expect(issues.every(i => i.severity === 'warning')).toBe(true)
    expect(issues.every(i => i.id.startsWith('migration-unapplied'))).toBe(true)
  })

  it('stays silent when there are no local files either', () => {
    expect(diffMigrations([], [])).toHaveLength(0)
  })
})

describe('checks.migrations.mode (issue #31)', () => {
  const local: LocalMigration[] = [
    { version: '001', name: 'initial', filename: '001_initial.sql' },
  ]

  it('warn forces a per-file warning even when nothing is tracked', () => {
    const issues = diffMigrations(local, [], 'warn')
    expect(issues).toHaveLength(1)
    expect(issues[0].severity).toBe('warning')
    expect(issues[0].id).toBe('migration-unapplied-001')
  })

  it('ignore suppresses the check entirely, including untracked DB records', () => {
    expect(diffMigrations(local, [], 'ignore')).toEqual([])
    expect(diffMigrations([], [{ version: '999', name: 'mystery' }], 'ignore')).toEqual([])
  })

  it('ignore short-circuits before any DB query or directory read', async () => {
    // Defensive: a user disabling the check should not pay for it, and a
    // broken migrations dir or unreachable DB must not surface an error.
    let queried = false
    let readDir = false
    const queryFn: QueryFn = async () => { queried = true; return [] }
    const readDirFn: ReadDirFn = async () => { readDir = true; return ['001_x.sql'] }

    const check = new MigrationsCheck(queryFn, readDirFn)

    // Reported as skipped rather than clean: switching the check off should
    // not look like a layer that ran and passed (issue #42). The
    // short-circuit itself is unchanged — nothing is read or queried.
    await expect(
      check.scan(mockContext({ checks: { migrations: { mode: 'ignore' } } })),
    ).rejects.toThrow(CheckSkipped)

    expect(queried).toBe(false)
    expect(readDir).toBe(false)
  })

  it('warn mode is honoured through the check', async () => {
    const readDirFn: ReadDirFn = async () => ['001_setup.sql', '002_data.sql']
    const queryFn: QueryFn = async () => []
    const check = new MigrationsCheck(queryFn, readDirFn)
    const issues = await check.scan(mockContext({ checks: { migrations: { mode: 'warn' } } }))
    expect(issues).toHaveLength(2)
    expect(issues.every(i => i.severity === 'warning')).toBe(true)
  })
})

describe('resolveMigrationsMode', () => {
  it('accepts the documented modes', () => {
    expect(resolveMigrationsMode('auto')).toBe('auto')
    expect(resolveMigrationsMode('warn')).toBe('warn')
    expect(resolveMigrationsMode('ignore')).toBe('ignore')
  })

  it('falls back to auto rather than throwing on a bad config value', () => {
    // A typo in a config file should not take the whole scan down.
    for (const bad of [undefined, null, '', 'WARN', 'off', 42, {}, []]) {
      expect(resolveMigrationsMode(bad)).toBe('auto')
    }
  })
})
