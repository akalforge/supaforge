/**
 * Integration tests for the migrations drift check against real Postgres containers.
 *
 * Creates a `supabase_migrations.schema_migrations` table in the target DB
 * and local migration files in a temp directory to test drift detection.
 *
 * Drift scenarios:
 *   - Local file exists but not recorded in DB (unapplied)
 *   - DB record exists but no local file (untracked)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { MigrationsCheck } from '../../src/checks/migrations.js'
import { MIGRATIONS_TABLE } from '../../src/constants.js'
import { TARGET_URL, skipIfNoContainers, makeConfig } from './helpers.js'

describe('integration: migrations check', () => {
  let tempDir: string
  let migrationsDir: string

  beforeAll(async () => {
    if (skipIfNoContainers()) return

    // Create temp directory with local migration files
    tempDir = await mkdtemp(join(tmpdir(), 'supaforge-mig-int-'))
    migrationsDir = join(tempDir, 'supabase', 'migrations')
    await mkdir(migrationsDir, { recursive: true })

    // Local files: 001 (applied), 002 (unapplied)
    await writeFile(join(migrationsDir, '20240101000000_create_users.sql'), 'CREATE TABLE users (id SERIAL);')
    await writeFile(join(migrationsDir, '20240201000000_add_posts.sql'), 'CREATE TABLE posts (id SERIAL);')

    // Create the migrations tracking table with one record (001 applied, 003 untracked)
    const client = new pg.Client({ connectionString: TARGET_URL! })
    await client.connect()
    try {
      await client.query(`CREATE SCHEMA IF NOT EXISTS supabase_migrations`)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${MIGRATIONS_TABLE} (
          version TEXT PRIMARY KEY,
          name TEXT,
          statements TEXT[] DEFAULT '{}'
        )
      `)
      await client.query(`DELETE FROM ${MIGRATIONS_TABLE}`)
      await client.query(
        `INSERT INTO ${MIGRATIONS_TABLE} (version, name) VALUES ($1, $2), ($3, $4)`,
        ['20240101000000', 'create_users', '20240301000000', 'add_comments'],
      )
    } finally {
      await client.end()
    }
  })

  afterAll(async () => {
    if (skipIfNoContainers()) return

    // Clean up DB
    const client = new pg.Client({ connectionString: TARGET_URL! })
    await client.connect()
    try {
      await client.query(`DROP TABLE IF EXISTS ${MIGRATIONS_TABLE}`)
      await client.query(`DROP SCHEMA IF EXISTS supabase_migrations CASCADE`)
    } finally {
      await client.end()
    }

    // Clean up temp dir
    if (tempDir) await rm(tempDir, { recursive: true, force: true })
  })

  it.skipIf(skipIfNoContainers())('should detect unapplied local migration', async () => {
    const config = makeConfig({
      checks: { migrations: { dir: migrationsDir } },
    })
    const check = new MigrationsCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // 20240201000000_add_posts.sql is local but not in DB
    const unapplied = issues.find(i => i.id === 'migration-unapplied-20240201000000')
    expect(unapplied).toBeDefined()
    expect(unapplied!.severity).toBe('warning')
    expect(unapplied!.title).toContain('Unapplied migration')
    expect(unapplied!.title).toContain('20240201000000_add_posts.sql')
    expect(unapplied!.sql?.up).toContain('INSERT INTO')
  })

  it.skipIf(skipIfNoContainers())('should detect untracked DB migration', async () => {
    const config = makeConfig({
      checks: { migrations: { dir: migrationsDir } },
    })
    const check = new MigrationsCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // 20240301000000_add_comments is in DB but no local file
    const untracked = issues.find(i => i.id === 'migration-untracked-20240301000000')
    expect(untracked).toBeDefined()
    expect(untracked!.severity).toBe('info')
    expect(untracked!.title).toContain('Untracked migration')
  })

  it.skipIf(skipIfNoContainers())('should not flag applied + tracked migration', async () => {
    const config = makeConfig({
      checks: { migrations: { dir: migrationsDir } },
    })
    const check = new MigrationsCheck()
    const issues = await check.scan({
      source: config.environments.source,
      target: config.environments.target,
      config,
    })

    // 20240101000000 exists both locally and in DB — no issue
    const applied = issues.find(i => i.id.includes('20240101000000'))
    expect(applied).toBeUndefined()
  })
})
