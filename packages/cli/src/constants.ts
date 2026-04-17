// ─── Directory & File Paths ──────────────────────────────────────────────────

/** Root directory for all SupaForge local state. */
export const SUPAFORGE_DIR = '.supaforge'

/** Subdirectory under SUPAFORGE_DIR for snapshot storage. */
export const SNAPSHOTS_SUBDIR = 'snapshots'

/** Subdirectory under SUPAFORGE_DIR for migration files. */
export const MIGRATIONS_SUBDIR = 'migrations'

/** Filename for snapshot manifests. */
export const SNAPSHOT_MANIFEST_FILE = 'manifest.json'

/** File path (relative to cwd) for branch tracking. */
export const BRANCHES_FILE = `${SUPAFORGE_DIR}/branches.json`

// ─── Supabase Management API ────────────────────────────────────────────────

/** Supabase Management API base URL for project-level endpoints. */
export const SUPABASE_MGMT_API = 'https://api.supabase.com/v1/projects'

// ─── Timeouts ────────────────────────────────────────────────────────────────

/** Timeout for @dbdiff/cli execution (2 minutes). */
export const DBDIFF_EXEC_TIMEOUT_MS = 120_000

/** Max stdout/stderr buffer for @dbdiff/cli (10 MB). */
export const DBDIFF_MAX_BUFFER = 10 * 1024 * 1024

/** Timeout for pg_dump | pg_restore pipeline (30 minutes). */
export const PG_PIPELINE_TIMEOUT_MS = 1_800_000

/** Interval between progress reports during clone (1 second). */
export const CLONE_PROGRESS_INTERVAL_MS = 1_000

/** Timeout for container runtime detection commands (5 seconds). */
export const RUNTIME_DETECT_TIMEOUT_MS = 5_000

/** Timeout for removing stopped containers (10 seconds). */
export const CONTAINER_RM_TIMEOUT_MS = 10_000

/** Timeout for starting a new container (60 seconds). */
export const CONTAINER_START_TIMEOUT_MS = 60_000

// ─── Scoring Weights ─────────────────────────────────────────────────────────

/** Score penalty per critical drift issue. */
export const SCORE_PENALTY_CRITICAL = 15

/** Score penalty per warning drift issue. */
export const SCORE_PENALTY_WARNING = 5

/** Score penalty per info drift issue. */
export const SCORE_PENALTY_INFO = 1

/** Score penalty per errored check (cannot confirm clean). */
export const SCORE_PENALTY_ERROR = 3

/** Maximum (perfect) drift score. */
export const SCORE_MAX = 100

// ─── Render / Formatting ─────────────────────────────────────────────────────

/** Padding width for check status lines in terminal output. */
export const CHECK_LINE_PADDING = 40

// ─── Clone-specific Schemas ──────────────────────────────────────────────────

/**
 * Additional Supabase-internal schemas to exclude from pg_dump when cloning.
 * These reference extensions (pg_graphql, pgsodium, supautils, etc.)
 * unavailable in vanilla PostgreSQL.
 *
 * Combined with DEFAULT_IGNORE_SCHEMAS from defaults.ts to form the
 * full exclusion list for `supaforge clone`.
 */
export const CLONE_EXTRA_EXCLUDE_SCHEMAS = [
  'graphql',
  '_realtime',
  '_analytics',
  'pgsodium_masks',
]

// ─── Migration Tracking ──────────────────────────────────────────────────────

/** Schema name for Supabase migration tracking. */
export const MIGRATIONS_SCHEMA = 'supabase_migrations'

/** Unqualified table name for migration records. */
export const MIGRATIONS_TABLE_NAME = 'schema_migrations'

/** Fully qualified migration tracking table name. */
export const MIGRATIONS_TABLE = `${MIGRATIONS_SCHEMA}.${MIGRATIONS_TABLE_NAME}`

// ─── Storage ─────────────────────────────────────────────────────────────────

/** Maximum number of objects to list per Supabase Storage API call. */
export const STORAGE_LIST_LIMIT = 1000
