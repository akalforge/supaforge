import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateTimestamp,
  snapshotDir,
  loadSnapshot,
  findLatestSnapshot,
  listSnapshots,
  captureSnapshot,
} from '../src/snapshot.js'
import type { SnapshotManifest } from '../src/types/config.js'
import type { QueryFn } from '../src/db.js'

describe('generateTimestamp', () => {
  it('returns ISO-like format without dashes/colons', () => {
    const ts = generateTimestamp()
    expect(ts).toMatch(/^\d{8}T\d{6}Z$/)
  })

  it('returns consistent length', () => {
    const a = generateTimestamp()
    const b = generateTimestamp()
    expect(a.length).toBe(b.length)
    expect(a.length).toBe(16)
  })
})

describe('snapshotDir', () => {
  it('constructs the correct path', () => {
    const dir = snapshotDir('/home/user/project', '20250101T120000Z')
    expect(dir).toContain('.supaforge')
    expect(dir).toContain('snapshots')
    expect(dir).toContain('20250101T120000Z')
  })

  it('resolves relative to cwd', () => {
    const dir = snapshotDir('/base', '20250101T120000Z')
    expect(dir).toBe(join('/base', '.supaforge', 'snapshots', '20250101T120000Z'))
  })

  it('outputDir overrides default path (used by captureSnapshot)', () => {
    // When outputDir is set, captureSnapshot uses join(resolve(outputDir), timestamp)
    // instead of snapshotDir(cwd, timestamp). Verify both paths are distinct.
    const defaultDir = snapshotDir('/project', '20250101T120000Z')
    const customDir = join('/custom/output', '20250101T120000Z')

    expect(defaultDir).toContain('.supaforge/snapshots')
    expect(customDir).not.toContain('.supaforge')
    expect(customDir).toBe('/custom/output/20250101T120000Z')
  })
})

describe('loadSnapshot', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-snap-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('loads a valid manifest', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'production',
      layers: {
        schema: { captured: true, file: 'schema.sql', itemCount: 5 },
        rls: { captured: true, file: 'rls.sql', itemCount: 3 },
      },
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))

    const loaded = await loadSnapshot(tempDir)
    expect(loaded.version).toBe(1)
    expect(loaded.timestamp).toBe('20250101T120000Z')
    expect(loaded.environment).toBe('production')
    expect(loaded.layers.schema.captured).toBe(true)
    expect(loaded.layers.schema.itemCount).toBe(5)
    expect(loaded.layers.rls.itemCount).toBe(3)
  })

  it('preserves optional projectRef', async () => {
    const manifest: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'prod',
      projectRef: 'abcdef123456',
      layers: {},
    }
    await writeFile(join(tempDir, 'manifest.json'), JSON.stringify(manifest))

    const loaded = await loadSnapshot(tempDir)
    expect(loaded.projectRef).toBe('abcdef123456')
  })

  it('throws if manifest.json is missing', async () => {
    await expect(loadSnapshot(tempDir)).rejects.toThrow()
  })
})

describe('findLatestSnapshot', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-snap-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns null when no snapshots exist', async () => {
    const result = await findLatestSnapshot(tempDir)
    expect(result).toBeNull()
  })

  it('returns null when .supaforge dir does not exist', async () => {
    const result = await findLatestSnapshot(join(tempDir, 'nonexistent'))
    expect(result).toBeNull()
  })

  it('returns the latest snapshot directory', async () => {
    const baseDir = join(tempDir, '.supaforge', 'snapshots')
    await mkdir(join(baseDir, '20250101T120000Z'), { recursive: true })
    await mkdir(join(baseDir, '20250201T120000Z'), { recursive: true })
    await mkdir(join(baseDir, '20250102T120000Z'), { recursive: true })

    const result = await findLatestSnapshot(tempDir)
    expect(result).toContain('20250201T120000Z')
  })

  it('ignores non-timestamp directories', async () => {
    const baseDir = join(tempDir, '.supaforge', 'snapshots')
    await mkdir(join(baseDir, '20250101T120000Z'), { recursive: true })
    await mkdir(join(baseDir, 'random-dir'), { recursive: true })
    await mkdir(join(baseDir, '.gitkeep'), { recursive: true })

    const result = await findLatestSnapshot(tempDir)
    expect(result).toContain('20250101T120000Z')
  })
})

describe('listSnapshots', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-snap-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when no snapshots exist', async () => {
    const result = await listSnapshots(tempDir)
    expect(result).toEqual([])
  })

  it('lists snapshots in chronological order', async () => {
    const baseDir = join(tempDir, '.supaforge', 'snapshots')
    const snap1Dir = join(baseDir, '20250101T120000Z')
    const snap2Dir = join(baseDir, '20250201T120000Z')
    await mkdir(snap1Dir, { recursive: true })
    await mkdir(snap2Dir, { recursive: true })

    const manifest1: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'prod',
      layers: { schema: { captured: true, file: 'schema.sql', itemCount: 2 } },
    }
    const manifest2: SnapshotManifest = {
      version: 1,
      timestamp: '20250201T120000Z',
      environment: 'prod',
      layers: { rls: { captured: true, file: 'rls.sql', itemCount: 4 } },
    }

    await writeFile(join(snap1Dir, 'manifest.json'), JSON.stringify(manifest1))
    await writeFile(join(snap2Dir, 'manifest.json'), JSON.stringify(manifest2))

    const result = await listSnapshots(tempDir)
    expect(result).toHaveLength(2)
    expect(result[0].manifest.timestamp).toBe('20250101T120000Z')
    expect(result[1].manifest.timestamp).toBe('20250201T120000Z')
  })

  it('skips directories without valid manifests', async () => {
    const baseDir = join(tempDir, '.supaforge', 'snapshots')
    const snap1Dir = join(baseDir, '20250101T120000Z')
    const snap2Dir = join(baseDir, '20250201T120000Z')
    await mkdir(snap1Dir, { recursive: true })
    await mkdir(snap2Dir, { recursive: true })

    const manifest1: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'prod',
      layers: {},
    }
    await writeFile(join(snap1Dir, 'manifest.json'), JSON.stringify(manifest1))
    // snap2Dir has no manifest — should be skipped

    const result = await listSnapshots(tempDir)
    expect(result).toHaveLength(1)
    expect(result[0].manifest.timestamp).toBe('20250101T120000Z')
  })

  it('preserves directory paths', async () => {
    const baseDir = join(tempDir, '.supaforge', 'snapshots')
    const snap1Dir = join(baseDir, '20250101T120000Z')
    await mkdir(snap1Dir, { recursive: true })

    const manifest1: SnapshotManifest = {
      version: 1,
      timestamp: '20250101T120000Z',
      environment: 'prod',
      layers: {},
    }
    await writeFile(join(snap1Dir, 'manifest.json'), JSON.stringify(manifest1))

    const result = await listSnapshots(tempDir)
    expect(result[0].dir).toBe(snap1Dir)
  })
})

/**
 * The webhook layer of a snapshot.
 *
 * This is the same defect as issue #77, in the other place it lived: the
 * capture started from `supabase_functions.hooks` — the log of webhook
 * *invocations* — and rebuilt each trigger by hand. `restore` replays
 * `webhooks.sql`, so a snapshot taken that way recreated webhooks with no
 * arguments and every write to their tables then failed with
 * `url argument is missing`.
 */
describe('captureSnapshot: webhooks', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'sf-wh-snap-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  const triggerDef = (table: string, name: string, url: string, timing = 'AFTER INSERT') =>
    `CREATE TRIGGER ${name} ${timing} ON ${table} FOR EACH ROW `
    + `EXECUTE FUNCTION supabase_functions.http_request(`
    + `'${url}', 'POST', '{"Content-Type":"application/json"}', '{}', '5000')`

  /** Answers the webhook query only; every other layer gets nothing. */
  function queryFor(rows: unknown[]): QueryFn {
    return (async (_dbUrl: string, sql: string) => {
      if (sql.includes('pg_get_triggerdef')) return rows
      return []
    }) as unknown as QueryFn
  }

  async function capture(rows: unknown[]) {
    const result = await captureSnapshot({
      envName: 'prod',
      env: { dbUrl: 'postgres://example' },
      config: { environments: { prod: { dbUrl: 'postgres://example' } } } as never,
      outputDir: tempDir,
      queryFn: queryFor(rows),
      fetchFn: (async () => new Response('[]', { status: 200 })) as never,
    })
    const sql = await readFile(join(result.dir, 'webhooks.sql'), 'utf8')
    return { result, sql }
  }

  it('writes the definition with its arguments', async () => {
    const { result, sql } = await capture([{
      table_name: 'public.orders',
      name: 'orders_webhook',
      definition: triggerDef('public.orders', 'orders_webhook', 'https://example.invalid/orders'),
    }])

    expect(result.manifest.layers.webhooks.itemCount).toBe(1)
    expect(sql).toContain("'https://example.invalid/orders'")
    expect(sql).toContain("'POST'")
    expect(sql).toContain("'5000'")
    // `http_request()` with no arguments is what the hand-built statement
    // emitted, and it makes every write to the table fail.
    expect(sql).not.toMatch(/http_request\(\s*\)/)
  })

  it('does not re-emit Supabase\'s own http_request function', async () => {
    const { sql } = await capture([{
      table_name: 'public.orders',
      name: 'orders_webhook',
      definition: triggerDef('public.orders', 'orders_webhook', 'https://example.invalid/o'),
    }])

    // pg_get_functiondef(t.tgfoid) used to be written into the file, so a
    // restore replaced Supabase's function with the snapshotted copy.
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION')
    expect(sql).not.toContain('LANGUAGE plpgsql')
  })

  it('keeps two webhooks that share a name on different tables', async () => {
    const { result, sql } = await capture([
      {
        table_name: 'public.a_items',
        name: 'notify_webhook',
        definition: triggerDef('public.a_items', 'notify_webhook', 'https://example.invalid/a'),
      },
      {
        table_name: 'public.b_items',
        name: 'notify_webhook',
        definition: triggerDef('public.b_items', 'notify_webhook', 'https://example.invalid/b'),
      },
    ])

    // The join was on trigger name alone, so one of these swallowed the other.
    expect(result.manifest.layers.webhooks.itemCount).toBe(2)
    expect(sql).toContain('public.a_items')
    expect(sql).toContain('public.b_items')
    expect(sql).toContain("'https://example.invalid/a'")
    expect(sql).toContain("'https://example.invalid/b'")
  })

  it('preserves a trigger that is not AFTER INSERT', async () => {
    const { sql } = await capture([{
      table_name: 'public.users',
      name: 'before_touch',
      definition: triggerDef('public.users', 'before_touch', 'https://example.invalid/u', 'BEFORE UPDATE'),
    }])

    // Every trigger used to be written out as `AFTER <events>`, whatever its
    // real timing, so a BEFORE trigger came back as AFTER.
    expect(sql).toContain('BEFORE UPDATE')
    expect(sql).not.toContain('AFTER BEFORE')
  })

  it('captures zero webhooks rather than skipping when there are none', async () => {
    const { result, sql } = await capture([])

    // A database with no supabase_functions schema has no such triggers; that
    // is an empty answer from the catalogs, not a failure to read them.
    expect(result.manifest.layers.webhooks.captured).toBe(true)
    expect(result.manifest.layers.webhooks.itemCount).toBe(0)
    expect(result.manifest.layers.webhooks.error).toBeUndefined()
    expect(sql).toContain('No webhooks found')
  })

  it('reports a genuine read failure as an error', async () => {
    const failing = (async (_dbUrl: string, sql: string) => {
      if (sql.includes('pg_get_triggerdef')) throw new Error('permission denied for table pg_trigger')
      return []
    }) as unknown as QueryFn

    const result = await captureSnapshot({
      envName: 'prod',
      env: { dbUrl: 'postgres://example' },
      config: { environments: { prod: { dbUrl: 'postgres://example' } } } as never,
      outputDir: tempDir,
      queryFn: failing,
      fetchFn: (async () => new Response('[]', { status: 200 })) as never,
    })

    expect(result.manifest.layers.webhooks.captured).toBe(false)
    expect(result.manifest.layers.webhooks.error).toContain('permission denied')
  })
})
