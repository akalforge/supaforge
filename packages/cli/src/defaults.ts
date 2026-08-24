/** Supabase internal schemas to ignore by default during drift scanning. */
export const DEFAULT_IGNORE_SCHEMAS = [
  'auth',
  'storage',
  'realtime',
  // Supabase's own realtime internals live in _realtime (underscore), a
  // different schema from 'realtime'. Its tables are owned by supabase_admin,
  // so reporting "RLS not enabled" on them is a finding nobody can act on —
  // it dragged the posture score down with unfixable noise.
  '_realtime',
  'vault',
  'net',
  'graphql_public',
  'supabase_migrations',
  'pgsodium',
  'pgtle',
  'supabase_functions',
  'extensions',
  'pg_catalog',
  'information_schema',
]

/** Hint text shown during `supaforge init` to guide users through the Supabase UI. */
export const INIT_HINTS = {
  DB_URL: [
    '  In Supabase: click "Connect" (top bar) -> Direct -> Session pooler -> URI -> copy the Connection string.',
    '  Format: postgresql://postgres.[ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres\n',
  ],
  PROJECT_URL: [
    '  Dashboard overview \u2192 click Copy \u2192 Project URL, or Project Settings \u2192 General \u2192 Project ID.',
  ],
  ACCESS_TOKEN: [
    '  supabase.com/dashboard/account/tokens \u2192 Generate new token.',
    '  This is a personal access token for the Supabase Management API (auth config, edge functions).\n',
  ],
  DATA_TABLES: [
    '  Reference-data tables are rows that should be identical across environments',
    '  (e.g. countries, currencies, feature_flags, plans).\n',
  ],
} as const

/** Error fragment for a relation that simply doesn't exist (expected for optional features). */
export const RELATION_NOT_FOUND = 'does not exist'

/**
 * The checks a local clone can only report noise for.
 *
 * A clone is vanilla PostgreSQL restored from a pg_dump: the Supabase-managed
 * layers have no local equivalent, and Postgres Roles & Grants is the same
 * story — Supabase's service roles do not exist on a plain server, so every
 * one of them reads as drift. On the diff that prompted issue #47 that was 227
 * findings, all of them clone artefacts, confirmed by a remote-to-remote diff
 * reporting zero.
 *
 * One list because the same advice was written out by hand in three places and
 * had already drifted into three different answers. Roles was in none of them:
 * it arrived as Layer 14, after the clone advice was written for a 13-layer set.
 */
export const CLONE_NOISE_CHECKS = [
  'storage',
  'auth',
  'edge-functions',
  'vault',
  'realtime',
  // different schema from 'realtime'. Its tables are owned by supabase_admin,
  // so reporting "RLS not enabled" on them is a finding nobody can act on —
  // it dragged the posture score down with unfixable noise.
  'roles',
] as const

/** The `--skip=` flags that suppress clone-only noise, as one command fragment. */
export const CLONE_SKIP_FLAGS = CLONE_NOISE_CHECKS.map(c => `--skip=${c}`).join(' ')
