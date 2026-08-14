export type MigrationsMode = 'auto' | 'warn' | 'ignore'

/**
 * Per-environment check overrides.
 *
 * A check can be fine against a fast local clone and hopeless against a
 * remote environment over a VPN, so a single top-level setting is too coarse
 * (issue #29). These apply on top of the top-level `checks` config.
 */
export interface EnvironmentChecksConfig {
  /** Checks to skip when this environment is the target. Unioned with the top-level list. */
  exclude?: string[]
  /** Schema-check overrides for this environment. */
  schema?: {
    /** Seconds before the schema/data diff is abandoned. Overrides the global default. */
    timeout?: number
  }
}

export interface EnvironmentConfig {
  dbUrl: string
  /** Check overrides applied when this environment is the diff target. */
  checks?: EnvironmentChecksConfig
  projectRef?: string
  /** Personal access token for Supabase Management API (auth config, edge functions). */
  accessToken?: string
  /** Base URL for self-hosted Supabase API gateway (e.g. http://localhost:54321). Overrides projectRef-based URL construction. */
  apiUrl?: string
}

export interface ChecksConfig {
  data?: { tables: string[] }
  migrations?: {
    dir?: string
    /**
     * How to report local migration files with no row in schema_migrations.
     *
     * - `auto` (default) — if the tracking table is empty but local files
     *   exist, report one INFO noting an untracked migration workflow rather
     *   than a warning per file. Otherwise warn per file as usual.
     * - `warn` — always warn per file, even when nothing is tracked.
     * - `ignore` — report nothing from this check at all.
     */
    mode?: MigrationsMode
  }
  /** Checks to always skip, regardless of CLI flags. Useful in config for clone environments. */
  exclude?: string[]
}

export interface SupaForgeConfig {
  environments: Record<string, EnvironmentConfig>
  source?: string
  target?: string
  ignoreSchemas?: string[]
  checks?: ChecksConfig
}

// ─── Snapshot Types ──────────────────────────────────────────────────────────

export interface SnapshotLayerInfo {
  captured: boolean
  file: string
  /** Number of items captured (e.g. policies, buckets, jobs). -1 if not applicable. */
  itemCount: number
  /** Error message if the layer failed to capture. */
  error?: string
  /** Human-readable reason the layer was skipped (when captured is false and there is no error). */
  skipReason?: string
}

export interface SnapshotManifest {
  version: 1
  timestamp: string
  environment: string
  projectRef?: string
  layers: Record<string, SnapshotLayerInfo>
}

// ─── Migration Types ─────────────────────────────────────────────────────────

export interface MigrationAction {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** Relative API path (e.g. /v1/projects/{ref}/config/auth). Ref is substituted at apply time. */
  path: string
  body?: unknown
  label: string
}

export interface MigrationFile {
  version: string
  description: string
  parent: string | null
  layers: string[]
  up: { sql: string[]; api: MigrationAction[] }
  down: { sql: string[]; api: MigrationAction[] }
}
