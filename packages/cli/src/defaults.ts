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
