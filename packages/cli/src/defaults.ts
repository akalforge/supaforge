/** Supabase internal schemas to ignore by default during drift scanning. */
export const DEFAULT_IGNORE_SCHEMAS = [
  'auth',
  'storage',
  'realtime',
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
    '  In Supabase: Dashboard overview \u2192 click Copy \u2192 Direct connection string.',
    '  Or: click \"Connect\" (top bar) \u2192 Direct connection \u2192 copy the URI.',
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
