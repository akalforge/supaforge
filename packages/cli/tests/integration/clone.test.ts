/**
 * Integration tests for the clone workflow against real Postgres.
 *
 * Covers the v0.0.6 fixes:
 *  - reconcileClones() discovers clone databases that exist on the server but
 *    are absent from .supaforge/branches.json ("works for new clones but not
 *    existing ones"), and flags tracked entries whose database is gone.
 *  - cloneRemoteToLocal() reproduces the source schema so the first schema diff
 *    against the clone is (near) zero.
 *
 * Uses TARGET_URL's server as the local server (where clone databases are
 * created/dropped) and SOURCE_URL as the remote to clone from. Gated by
 * skipIfNoContainers so it no-ops when no test database is configured.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import {
  reconcileClones,
  cloneRemoteToLocal,
  replaceDbName,
  loadManifest,
  type BranchesManifest,
} from '../../src/branch'
import { runDbDiff, sqlToIssues } from '../../src/dbdiff'
import { SOURCE_URL, TARGET_URL, skipIfNoContainers } from './helpers'

const skip = skipIfNoContainers()

/** Create a database on the given server (idempotent). */
async function createDb(serverUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: replaceDbName(serverUrl, 'postgres') })
  await client.connect()
  try {
    await client.query(`DROP DATABASE IF EXISTS "${name}"`)
    await client.query(`CREATE DATABASE "${name}"`)
  } finally {
    await client.end()
  }
}

/** Drop a database on the given server, terminating connections first. */
async function dropDb(serverUrl: string, name: string): Promise<void> {
  const client = new pg.Client({ connectionString: replaceDbName(serverUrl, 'postgres') })
  await client.connect()
  try {
    await client.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [name],
    )
    await client.query(`DROP DATABASE IF EXISTS "${name}"`)
  } finally {
    await client.end()
  }
}

async function writeManifest(cwd: string, manifest: BranchesManifest): Promise<void> {
  const dir = join(cwd, '.supaforge')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'branches.json'), JSON.stringify(manifest, null, 2))
}

describe('integration: reconcileClones', () => {
  let tempDir: string
  const createdDbs: string[] = []

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-clone-int-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true })
    if (!skip) {
      for (const db of createdDbs.splice(0)) {
        await dropDb(TARGET_URL!, db).catch(() => {})
      }
    }
  })

  it.skipIf(skip)('discovers a clone database that is absent from the manifest', async () => {
    const dbName = `sf_disc_${Date.now()}`
    await createDb(TARGET_URL!, dbName)
    createdDbs.push(dbName)

    // Manifest is empty — the database exists on the server but was never tracked.
    await writeManifest(tempDir, { branches: [] })

    const clones = await reconcileClones({
      localServerUrl: TARGET_URL!,
      configuredLocalDb: dbName,
      cwd: tempDir,
    })

    const found = clones.find(c => c.dbName === dbName)
    expect(found).toBeDefined()
    expect(found?.discovered).toBe(true)
  })

  it.skipIf(skip)('backfills discovered clones into the manifest', async () => {
    const dbName = `sf_backfill_${Date.now()}`
    await createDb(TARGET_URL!, dbName)
    createdDbs.push(dbName)
    await writeManifest(tempDir, { branches: [] })

    await reconcileClones({
      localServerUrl: TARGET_URL!,
      configuredLocalDb: dbName,
      cwd: tempDir,
    })

    const manifest = await loadManifest(tempDir)
    expect(manifest.branches.some(b => b.dbName === dbName)).toBe(true)
  })

  it.skipIf(skip)('flags a tracked clone whose database no longer exists as missing', async () => {
    const goneDb = `sf_gone_${Date.now()}`
    await writeManifest(tempDir, {
      branches: [{
        name: goneDb,
        dbName: goneDb,
        dbUrl: replaceDbName(TARGET_URL!, goneDb),
        createdFrom: 'production',
        createdAt: '2025-01-01T00:00:00.000Z',
        schemaOnly: false,
      }],
    })

    const clones = await reconcileClones({ localServerUrl: TARGET_URL!, cwd: tempDir })
    const entry = clones.find(c => c.dbName === goneDb)
    expect(entry?.missing).toBe(true)
  })

  it.skipIf(skip)('does not duplicate an already-tracked clone that still exists', async () => {
    const dbName = `sf_tracked_${Date.now()}`
    await createDb(TARGET_URL!, dbName)
    createdDbs.push(dbName)
    await writeManifest(tempDir, {
      branches: [{
        name: dbName,
        dbName,
        dbUrl: replaceDbName(TARGET_URL!, dbName),
        createdFrom: 'production',
        createdAt: '2025-01-01T00:00:00.000Z',
        schemaOnly: false,
      }],
    })

    const clones = await reconcileClones({
      localServerUrl: TARGET_URL!,
      configuredLocalDb: dbName,
      cwd: tempDir,
    })

    expect(clones.filter(c => c.dbName === dbName)).toHaveLength(1)
    expect(clones.find(c => c.dbName === dbName)?.missing).toBeUndefined()
  })
})

describe('integration: cloneRemoteToLocal → diff', () => {
  const cloneDbName = `sf_clone_${Date.now()}`

  afterEach(async () => {
    if (!skip) await dropDb(TARGET_URL!, cloneDbName).catch(() => {})
  })

  it.skipIf(skip)('clones the remote schema so the schema diff is empty', async () => {
    const localBaseUrl = replaceDbName(TARGET_URL!, 'postgres')

    await cloneRemoteToLocal({
      remoteUrl: SOURCE_URL!,
      localBaseUrl,
      localDbName: cloneDbName,
      schemaOnly: true,
    })

    // The clone database now exists with the source's tables.
    const cloneUrl = replaceDbName(TARGET_URL!, cloneDbName)
    const client = new pg.Client({ connectionString: cloneUrl })
    await client.connect()
    let tableCount = 0
    try {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'`,
      )
      tableCount = rows[0].n
    } finally {
      await client.end()
    }
    expect(tableCount).toBeGreaterThan(0)

    // A schema diff between the source and its fresh clone should be (near) zero.
    const result = await runDbDiff({
      sourceUrl: SOURCE_URL!,
      targetUrl: cloneUrl,
      type: 'schema',
      include: 'both',
      ignoreSchemas: ['information_schema', 'pg_catalog', 'pg_toast'],
    })
    const issues = sqlToIssues(result, 'schema', ['information_schema', 'pg_catalog', 'pg_toast'])
    expect(issues).toHaveLength(0)
  })
})
