import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadMigrations,
  listMigrationFiles,
  MIGRATIONS_TABLE,
} from '../src/migration.js'
import type { MigrationFile } from '../src/types/config.js'

describe('MIGRATIONS_TABLE', () => {
  it('is the expected table name', () => {
    expect(MIGRATIONS_TABLE).toBe('_supaforge_migrations')
  })
})

describe('loadMigrations', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-mig-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when no migrations exist', async () => {
    const result = await loadMigrations(tempDir)
    expect(result).toEqual([])
  })

  it('returns empty array when .supaforge dir does not exist', async () => {
    const result = await loadMigrations(join(tempDir, 'nonexistent'))
    expect(result).toEqual([])
  })

  it('loads migrations in timestamp order', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['CREATE TABLE foo (id int);'], api: [] },
      down: { sql: ['DROP TABLE foo;'], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: ['CREATE POLICY "test" ON foo FOR SELECT TO public USING (true);'], api: [] },
      down: { sql: ['DROP POLICY "test" ON foo;'], api: [] },
    }

    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await loadMigrations(tempDir)
    expect(result).toHaveLength(2)
    expect(result[0].version).toBe('20250101T120000Z')
    expect(result[0].description).toBe('first')
    expect(result[1].version).toBe('20250201T120000Z')
    expect(result[1].parent).toBe('20250101T120000Z')
  })

  it('ignores non-JSON files', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['CREATE TABLE foo (id int);'], api: [] },
      down: { sql: ['DROP TABLE foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, 'README.md'), '# Migrations')

    const result = await loadMigrations(tempDir)
    expect(result).toHaveLength(1)
  })

  it('preserves up and down SQL', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m: MigrationFile = {
      version: '20250101T120000Z',
      description: 'test',
      parent: null,
      layers: ['schema', 'rls'],
      up: {
        sql: ['CREATE TABLE foo (id int);', 'CREATE POLICY "p1" ON foo FOR SELECT TO public USING (true);'],
        api: [{ method: 'PATCH', path: '/v1/projects/{ref}/config/auth', body: { site_url: 'https://example.com' }, label: 'Update auth config' }],
      },
      down: {
        sql: ['DROP POLICY "p1" ON foo;', 'DROP TABLE foo;'],
        api: [],
      },
    }
    await writeFile(join(dir, '20250101T120000Z_test.json'), JSON.stringify(m))

    const result = await loadMigrations(tempDir)
    expect(result[0].up.sql).toHaveLength(2)
    expect(result[0].up.api).toHaveLength(1)
    expect(result[0].down.sql).toHaveLength(2)
    expect(result[0].layers).toEqual(['schema', 'rls'])
  })
})

describe('listMigrationFiles', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-mig-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when no migrations exist', async () => {
    const result = await listMigrationFiles(tempDir)
    expect(result).toEqual([])
  })

  it('returns metadata for each migration', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'initial setup',
      parent: null,
      layers: ['schema', 'rls'],
      up: { sql: ['CREATE TABLE foo (id int);'], api: [] },
      down: { sql: ['DROP TABLE foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_initial-setup.json'), JSON.stringify(m1))

    const result = await listMigrationFiles(tempDir)
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250101T120000Z')
    expect(result[0].description).toBe('initial setup')
    expect(result[0].layers).toEqual(['schema', 'rls'])
    expect(result[0].file).toBe('20250101T120000Z_initial-setup.json')
  })

  it('lists in sorted order', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: [], api: [] },
      down: { sql: [], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: [], api: [] },
      down: { sql: [], api: [] },
    }

    // Write in reverse order — should still list sorted
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m2))

    const result = await listMigrationFiles(tempDir)
    expect(result).toHaveLength(2)
    expect(result[0].version).toBe('20250101T120000Z')
    expect(result[1].version).toBe('20250201T120000Z')
  })
})
