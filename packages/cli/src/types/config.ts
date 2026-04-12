export interface EnvironmentConfig {
  dbUrl: string
  projectRef?: string
  /** Personal access token for Supabase Management API (auth config, edge functions). */
  accessToken?: string
  /** Base URL for self-hosted Supabase API gateway (e.g. http://localhost:54321). Overrides projectRef-based URL construction. */
  apiUrl?: string
}

export interface ChecksConfig {
  data?: { tables: string[] }
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
