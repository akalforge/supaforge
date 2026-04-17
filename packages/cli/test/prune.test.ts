import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdir, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pruneSnapshots, DEFAULT_KEEP_COUNT } from '../src/snapshot.js'

describe('pruneSnapshots', () => {
  let tempDir: string
  const snapshotsDir = () => join(tempDir, '.supaforge', 'snapshots')

  async function createSnapshot(timestamp: string): Promise<void> {
    const dir = join(snapshotsDir(), timestamp)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({
      version: 1,
      timestamp,
      environment: 'test',
      layers: {},
    }))
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-prune-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
  })

  it('exports DEFAULT_KEEP_COUNT of 7', () => {
    expect(DEFAULT_KEEP_COUNT).toBe(7)
  })

  it('does nothing when fewer snapshots than keep count', async () => {
    await createSnapshot('20260101T120000Z')
    await createSnapshot('20260102T120000Z')

    const result = await pruneSnapshots(7, tempDir)
    expect(result.deleted).toEqual([])
    expect(result.kept).toHaveLength(2)
  })

  it('does nothing when exactly at keep count', async () => {
    for (let i = 1; i <= 3; i++) {
      await createSnapshot(`2026010${i}T120000Z`)
    }
    const result = await pruneSnapshots(3, tempDir)
    expect(result.deleted).toEqual([])
    expect(result.kept).toHaveLength(3)
  })

  it('deletes oldest snapshots when over keep count', async () => {
    const timestamps = [
      '20260101T120000Z',
      '20260102T120000Z',
      '20260103T120000Z',
      '20260104T120000Z',
      '20260105T120000Z',
    ]
    for (const ts of timestamps) {
      await createSnapshot(ts)
    }

    const result = await pruneSnapshots(3, tempDir)
    expect(result.deleted).toHaveLength(2)
    expect(result.kept).toHaveLength(3)

    // Verify the oldest two are gone
    const remaining = await readdir(snapshotsDir())
    expect(remaining.sort()).toEqual([
      '20260103T120000Z',
      '20260104T120000Z',
      '20260105T120000Z',
    ])
  })

  it('keeps only 1 when keep=1', async () => {
    await createSnapshot('20260101T120000Z')
    await createSnapshot('20260102T120000Z')
    await createSnapshot('20260103T120000Z')

    const result = await pruneSnapshots(1, tempDir)
    expect(result.deleted).toHaveLength(2)
    expect(result.kept).toHaveLength(1)

    const remaining = await readdir(snapshotsDir())
    expect(remaining).toEqual(['20260103T120000Z'])
  })

  it('handles empty snapshots directory', async () => {
    const result = await pruneSnapshots(7, tempDir)
    expect(result.deleted).toEqual([])
    expect(result.kept).toEqual([])
  })
})
