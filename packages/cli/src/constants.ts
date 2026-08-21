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

/**
 * Default timeout for @dbdiff/cli execution (5 minutes).
 *
 * Large Supabase schemas can take several minutes to diff. The previous
 * 2-minute limit silently killed the process mid-run, surfacing dbdiff's
 * last progress log line as a bogus "error". Override at runtime with the
 * SUPAFORGE_DBDIFF_TIMEOUT environment variable (value in seconds), or per
 * environment via checks.schema.timeout in supaforge.config.json.
 *
 * Raised from 300s: the schema pre-scan made the common case much faster, so
 * the runs still approaching the ceiling are precisely the ones that need
 * headroom, and a timeout costs the whole layer rather than degrading it.
 */
export const DBDIFF_EXEC_TIMEOUT_MS = 600_000

/**
 * Default bound on establishing a PostgreSQL connection (15 seconds).
 *
 * `pg` defaults connectionTimeoutMillis to 0 — wait forever. That is invisible
 * for the common failures, because the socket layer errors out on its own: a
 * refused connection fails immediately, an unroutable host after the OS TCP
 * timeout. But a host that *accepts* the connection and then never completes
 * the startup handshake — a paused container, a dropped VPN tunnel, an
 * overloaded server — leaves nothing to time it out, and the command blocks
 * indefinitely with no output (issue #44).
 *
 * 15s is long enough for a slow link and short enough to fail usefully.
 * Override with SUPAFORGE_CONNECT_TIMEOUT (in seconds).
 */
export const DB_CONNECT_TIMEOUT_MS = 15_000

/**
 * Bound on the preflight version probe (15 seconds).
 *
 * The handshake can complete on a server that then stalls before answering,
 * so bounding the connect alone still leaves a way to hang. Applied only to
 * the probe — a scan or migration query is legitimately long-running and must
 * not inherit this.
 */
export const DB_PROBE_TIMEOUT_MS = 15_000

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

// ─── Run Log ─────────────────────────────────────────────────────────────────

/** Directory (relative to home) where the run log is stored. */
export const RUN_LOG_DIR = '.supaforge'

/** Filename for the run log. */
export const RUN_LOG_FILE = 'run-log.jsonl'

/** Maximum number of run log entries to keep. */
export const RUN_LOG_MAX_ENTRIES = 500
