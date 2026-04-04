/**
 * Shared helpers for integration tests.
 *
 * Provides database seeding and config construction for tests
 * that need a known-good starting state.
 */
import { readFile } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'
import type { SupaForgeConfig } from '../../src/types/config'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(__dirname, '..', 'fixtures')

export const SOURCE_URL = process.env.SUPAFORGE_TEST_SOURCE_URL
export const TARGET_URL = process.env.SUPAFORGE_TEST_TARGET_URL

export function skipIfNoContainers(): boolean {
  return !SOURCE_URL || !TARGET_URL
}

/**
 * Default config used by most integration tests.
 * Includes ignoreSchemas for system catalogs that would otherwise
 * produce false positives.
 */
export function makeConfig(overrides?: Partial<SupaForgeConfig>): SupaForgeConfig {
  return {
    environments: {
      source: { dbUrl: SOURCE_URL! },
      target: { dbUrl: TARGET_URL! },
    },
    source: 'source',
    target: 'target',
    ignoreSchemas: [
      'information_schema', 'pg_catalog', 'pg_toast',
      'extensions', 'graphql', 'graphql_public',
      'pgsodium', 'realtime', 'vault', '_realtime',
    ],
    ...overrides,
  }
}

/**
 * Re-seed a database by executing a SQL fixture file.
 * The seed files are idempotent (DROP + CREATE), so this is safe to call
 * multiple times.
 */
async function executeSeedFile(dbUrl: string, filename: string): Promise<void> {
  const sql = await readFile(join(FIXTURES_DIR, filename), 'utf8')
  const client = new pg.Client({ connectionString: dbUrl })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

/** Re-seed the target database to its original drifted state. */
export async function reseedTarget(): Promise<void> {
  await executeSeedFile(TARGET_URL!, 'seed-target.sql')
}

/** Re-seed the source database to its original state. */
export async function reseedSource(): Promise<void> {
  await executeSeedFile(SOURCE_URL!, 'seed-source.sql')
}

/** Re-seed both databases to their original states. */
export async function reseedAll(): Promise<void> {
  await Promise.all([reseedSource(), reseedTarget()])
}
