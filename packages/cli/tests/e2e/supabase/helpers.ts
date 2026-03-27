/**
 * Shared helpers for Supabase E2E tests.
 *
 * Reads connection details from environment variables set by scripts/test-e2e.sh.
 */
import type { SupaForgeConfig } from '../../../src/types/config'

/** Required environment variables for E2E tests. */
const ENV_VARS = [
  'SUPAFORGE_E2E_SOURCE_DB_URL',
  'SUPAFORGE_E2E_TARGET_DB_URL',
  'SUPAFORGE_E2E_SOURCE_API_URL',
  'SUPAFORGE_E2E_TARGET_API_URL',
  'SUPAFORGE_E2E_SOURCE_SERVICE_KEY',
  'SUPAFORGE_E2E_TARGET_SERVICE_KEY',
] as const

/** Returns true if required env vars are missing (tests should skip). */
export function shouldSkip(): boolean {
  return ENV_VARS.some(v => !process.env[v])
}

/** Schemas to ignore during scanning (Supabase internal schemas). */
const IGNORE_SCHEMAS = [
  'information_schema',
  'pg_catalog',
  'pg_toast',
  'extensions',
  'graphql',
  'graphql_public',
  'pgsodium',
  'realtime',
  'vault',
  '_realtime',
  'supabase_migrations',
  'auth',
  'net',
  'pgsodium_masks',
  'pgbouncer',
  'supabase_functions',
  '_analytics',
  'cron',
  // storage schema is handled exclusively by the storage layer (not the RLS layer)
  'storage',
]

/** Build SupaForgeConfig from environment variables. */
export function buildConfig(): SupaForgeConfig {
  return {
    environments: {
      source: {
        dbUrl: process.env.SUPAFORGE_E2E_SOURCE_DB_URL!,
        apiKey: process.env.SUPAFORGE_E2E_SOURCE_SERVICE_KEY,
        apiUrl: process.env.SUPAFORGE_E2E_SOURCE_API_URL,
      },
      target: {
        dbUrl: process.env.SUPAFORGE_E2E_TARGET_DB_URL!,
        apiKey: process.env.SUPAFORGE_E2E_TARGET_SERVICE_KEY,
        apiUrl: process.env.SUPAFORGE_E2E_TARGET_API_URL,
      },
    },
    source: 'source',
    target: 'target',
    ignoreSchemas: IGNORE_SCHEMAS,
  }
}
