import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  generateTimestamp,
  snapshotDir,
  loadSnapshot,
  findLatestSnapshot,
  listSnapshots,
} from '../src/snapshot.js'
import type { SnapshotManifest } from '../src/types/config.js'

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
