import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  previewSnapshotRestore,
  previewMigrationRestore,
} from '../src/restore.js'
import type { SnapshotManifest, MigrationFile } from '../src/types/config.js'

describe('previewSnapshotRestore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-restore-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns layers with their executable SQL statements', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 2 },
        schema: { captured: true, file: 'schema.sql', itemCount: 1 },
        rls: { captured: true, file: 'rls.sql', itemCount: 1 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), [
      '-- SupaForge Extensions Snapshot',
      '-- 2 extensions',
      '',
      'CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA "extensions";',
      'CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";',
    ].join('\n'))
    await writeFile(join(tempDir, 'schema.sql'), [
      '-- Schema',
      'CREATE TABLE public.users (id uuid PRIMARY KEY);',
    ].join('\n'))
    await writeFile(join(tempDir, 'rls.sql'), [
      '-- SupaForge RLS Policy Snapshot',
      '-- 1 policies',
      '',
      'CREATE POLICY "users_select"',
      '  ON "public"."users"',
      '  AS PERMISSIVE',
      '  FOR SELECT',
      '  TO public',
      '  USING (true);',
    ].join('\n'))

    const preview = await previewSnapshotRestore(tempDir)

    const extLayer = preview.find(p => p.layer === 'extensions')
    expect(extLayer).toBeDefined()
    expect(extLayer!.statements.length).toBeGreaterThanOrEqual(1)

    const schemaLayer = preview.find(p => p.layer === 'schema')
    expect(schemaLayer).toBeDefined()

    const rlsLayer = preview.find(p => p.layer === 'rls')
    expect(rlsLayer).toBeDefined()
  })

  it('skips uncaptured layers', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 1 },
        cron: { captured: false, file: 'cron.sql', itemCount: 0 },
        webhooks: { captured: false, file: 'webhooks.sql', itemCount: 0 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), 'CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')

    const preview = await previewSnapshotRestore(tempDir)
    expect(preview.find(p => p.layer === 'cron')).toBeUndefined()
    expect(preview.find(p => p.layer === 'webhooks')).toBeUndefined()
    expect(preview.find(p => p.layer === 'extensions')).toBeDefined()
  })

  it('respects dependency order (extensions before schema before rls)', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 1 },
        schema: { captured: true, file: 'schema.sql', itemCount: 1 },
        rls: { captured: true, file: 'rls.sql', itemCount: 1 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), 'CREATE EXTENSION IF NOT EXISTS "pgcrypto";')
    await writeFile(join(tempDir, 'schema.sql'), 'CREATE TABLE foo (id int);')
    await writeFile(join(tempDir, 'rls.sql'), 'CREATE POLICY "p" ON foo FOR SELECT TO public USING (true);')

    const preview = await previewSnapshotRestore(tempDir)
    const layerOrder = preview.map(p => p.layer)
    const extIdx = layerOrder.indexOf('extensions')
    const schemaIdx = layerOrder.indexOf('schema')
    const rlsIdx = layerOrder.indexOf('rls')

    expect(extIdx).toBeLessThan(schemaIdx)
    expect(schemaIdx).toBeLessThan(rlsIdx)
  })

  it('handles empty SQL files gracefully', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        extensions: { captured: true, file: 'extensions.sql', itemCount: 0 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(tempDir, 'extensions.sql'), '-- No extensions\n')

    const preview = await previewSnapshotRestore(tempDir)
    // Should not include a layer with 0 executable statements
    expect(preview.find(p => p.layer === 'extensions')).toBeUndefined()
  })
})

describe('previewMigrationRestore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-restore-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns all migrations when no version filter', async () => {
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
      up: { sql: ['CREATE POLICY test ON foo FOR SELECT TO public USING (true);'], api: [] },
      down: { sql: ['DROP POLICY test ON foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir)
    expect(result).toHaveLength(2)
    expect(result[0].version).toBe('20250101T120000Z')
    expect(result[1].version).toBe('20250201T120000Z')
  })

  it('returns empty when no migrations exist', async () => {
    const result = await previewMigrationRestore(tempDir)
    expect(result).toEqual([])
  })

  it('filters by toVersion', async () => {
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
      up: { sql: ['CREATE POLICY test ON foo;'], api: [] },
      down: { sql: ['DROP POLICY test ON foo;'], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir, '20250101T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250101T120000Z')
  })

  it('filters by fromVersion', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const m1: MigrationFile = {
      version: '20250101T120000Z',
      description: 'first',
      parent: null,
      layers: ['schema'],
      up: { sql: ['SELECT 1;'], api: [] },
      down: { sql: [], api: [] },
    }
    const m2: MigrationFile = {
      version: '20250201T120000Z',
      description: 'second',
      parent: '20250101T120000Z',
      layers: ['rls'],
      up: { sql: ['SELECT 2;'], api: [] },
      down: { sql: [], api: [] },
    }
    await writeFile(join(dir, '20250101T120000Z_first.json'), JSON.stringify(m1))
    await writeFile(join(dir, '20250201T120000Z_second.json'), JSON.stringify(m2))

    const result = await previewMigrationRestore(tempDir, undefined, '20250201T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250201T120000Z')
  })

  it('filters by both fromVersion and toVersion', async () => {
    const dir = join(tempDir, '.supaforge', 'migrations')
    await mkdir(dir, { recursive: true })

    const versions = ['20250101T120000Z', '20250201T120000Z', '20250301T120000Z']
    for (const v of versions) {
      const m: MigrationFile = {
        version: v,
        description: `migration-${v}`,
        parent: null,
        layers: ['schema'],
        up: { sql: ['SELECT 1;'], api: [] },
        down: { sql: [], api: [] },
      }
      await writeFile(join(dir, `${v}_migration.json`), JSON.stringify(m))
    }

    const result = await previewMigrationRestore(tempDir, '20250201T120000Z', '20250201T120000Z')
    expect(result).toHaveLength(1)
    expect(result[0].version).toBe('20250201T120000Z')
  })
})
